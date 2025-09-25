import appRootPath from 'app-root-path';
import compareFunc from 'compare-func';
import IntervalTree from 'node-interval-tree';
import { join } from 'path';
import { init, head, last } from 'ramda';
import { Readable } from 'stream';
import config from './config';
import logger from './logger';
import { execute } from './utils';

const BLACKFRAME_FILTER_OUTPUT_PATTERN = new RegExp(
  [
    /\[Parsed_blackframe_(?<filterNum>\d+) @ \w+\]/,
    /frame:(?<frame>\d+)/,
    /pblack:(?<pctBlack>\d+)/,
    /pts:\d+/,
    /t:(?<time>[\d.]+)/,
    /type:\w/,
    /last_keyframe:\d+/
  ]
    .map((r) => r.source)
    .join(' ')
);

const SILENCEDETECT_FILTER_OUTPUT_PATTERN = new RegExp(
  [
    /\[silencedetect @ \w+\]/,
    /silence_end: (?<endTime>[\d.]+) \|/,
    /silence_duration: (?<duration>[\d.]+)/
  ]
    .map((r) => r.source)
    .join(' ')
);

const CROPDETECT_FILTER_OUTPUT_PATTERN = new RegExp(
  [
    /\[Parsed_cropdetect_(?<filterNum>\d+) @ \w+\]/,
    /x1:(?<x1>\d+)/,
    /x2:(?<x2>\d+)/,
    /y1:(?<y1>\d+)/,
    /y2:(?<y2>\d+)/,
    /w:(?<width>\d+)/,
    /h:(?<height>\d+)/,
    /x:(?<x>\d+)/,
    /y:(?<y>\d+)/,
    /pts:\d+/,
    /t:(?<time>[\d.]+)/,
    /crop=\d+:\d+:\d+:\d+/
  ]
    .map((r) => r.source)
    .join(' ')
);

const FULL_CROP_WIDTH = 1920;

interface FrameSearchStrategy {
  name: string;
  filters: Array<number>;
  maxSkip?: number;
  minSilenceSeconds?: number;
  minFrames: number;
}

interface Silence {
  startTime: number;
  endTime: number;
}

interface BlackframeOutput {
  filterNum: number;
  frameNum: number;
  time: number;
}

const MINIMUM_BOUNDARY_SILENCE_SECONDS = 0.1;

const BOUNDARY_STRATEGIES = [
  {
    name: 'black-logo',
    filters: [11],
    minSilenceSeconds: 1.5,
    minFrames: 5
  },
  {
    name: 'white-logo',
    filters: [13],
    minSilenceSeconds: 1.5,
    minFrames: 5
  },
  {
    name: 'white-borders-logo',
    filters: [15],
    minSilenceSeconds: 1.5,
    minFrames: 5
  },
  {
    name: 'black-logo-ai-subtitles',
    filters: [17],
    minSilenceSeconds: 1.5,
    minFrames: 5
  },
  {
    name: 'black-no-logo-ai-subtitles',
    filters: [19],
    minSilenceSeconds: 1.5,
    minFrames: 5
  },
  {
    name: 'no-logo',
    filters: [20],
    minSilenceSeconds: 0.1,
    minFrames: 3
  },
  {
    name: 'newsline',
    filters: [22],
    minSilenceSeconds: 0,
    minFrames: 1
  }
] as Array<FrameSearchStrategy>;

const NEWS_BANNER_STRATEGY = {
  name: 'news-banner-background',
  filters: [13],
  maxSkip: 120,
  minFrames: 120
} as FrameSearchStrategy;

const getFfprobeArguments = (path: string): Array<string> =>
  [['-v', 'quiet'], ['-print_format', 'json'], '-show_format', path].flat();

export const getFileDuration = async (path: string): Promise<number> => {
  const args = getFfprobeArguments(path);

  logger.debug(`Invoking ffprobe with args: ${args.join(' ')}`);

  const { stdout } = await execute('ffprobe', args);
  const {
    format: { duration }
  } = JSON.parse(stdout.join(''));

  return parseFloat(duration) * 1_000;
};

export const getStreamCount = async (path: string): Promise<number> => {
  const args = getFfprobeArguments(path);

  logger.debug(`Invoking ffprobe with args: ${args.join(' ')}`);

  const { stdout } = await execute('ffprobe', args);
  const {
    format: { nb_streams: numStreams }
  } = JSON.parse(stdout.join(''));

  return parseInt(numStreams);
};

// Returns primary video stream dimensions using ffprobe so the pipeline
// can size filters dynamically instead of assuming 1920x1080.
export const getVideoDimensions = async (
  path: string
): Promise<{ width: number; height: number }> => {
  const args = [
    ['-v', 'error'],
    ['-print_format', 'json'],
    ['-select_streams', 'v:0'],
    ['-show_entries', 'stream=width,height'],
    ['-show_streams'],
    path
  ].flat();

  logger.debug(`Invoking ffprobe with args: ${args.join(' ')}`);

  const { stdout } = await execute('ffprobe', args);
  const result = JSON.parse(stdout.join(''));
  const stream = (result.streams ?? [])[0] ?? {};
  const width = stream.width ?? stream.coded_width;
  const height = stream.height ?? stream.coded_height;

  if (!width || !height) {
    throw new Error('Unable to read video dimensions');
  }

  return { width, height };
};

const getFfmpegBoundaryDetectionArguments = (
  path: string,
  from: number,
  limit: number
): Array<string> =>
  [
    '-copyts',
    config.threadLimit > 0 ? ['-threads', `${config.threadLimit}`] : [],
    ['-ss', `${from / 1000}`],
    limit ? ['-t', `${limit / 1000}`] : [],
    ['-i', path],
    ['-i', join(appRootPath.path, 'data/black_cropped.jpg')],
    ['-i', join(appRootPath.path, 'data/white_cropped.jpg')],
    ['-i', join(appRootPath.path, 'data/white_borders_cropped.jpg')],
    ['-i', join(appRootPath.path, 'data/black_cropped_aisubs.jpg')],
    ['-i', join(appRootPath.path, 'data/black_cropped_nologo_aisubs.jpg')],
    ['-i', join(appRootPath.path, 'data/newsline_intro.jpg')],
    [
      '-filter_complex',
      [
        // Extract luma channels
        '[0:0]extractplanes=y[vy]',
        '[1]extractplanes=y[by]',
        '[2]extractplanes=y[wy]',
        '[3]extractplanes=y[wby]',
        '[4]extractplanes=y[bay]',
        '[5]extractplanes=y[bnlay]',
        '[6]extractplanes=y[nly]',
        '[vy]split=outputs=2[vy0][vy1]',
        // Crop top left corner
        '[vy0]crop=w=960:h=540:x=0:y=0[cvy]',
        '[cvy]split=outputs=6[cvy0][cvy1][cvy2][cvy3][cvy4][cvy5]',
        // Detect black frames with logo
        '[cvy0][by]blend=difference,blackframe=99',
        // Detect white frames with logo
        '[cvy1][wy]blend=difference,blackframe=99:50',
        // Detect white frames with logo and border
        '[cvy2][wby]blend=difference,blackframe=99:50',
        // Detect black frames with logo and AI Subtitle text
        '[cvy3][bay]blend=difference,blackframe=99',
        // Detect black frames with no logo, with AI Subtitle text
        '[cvy4][bnlay]blend=difference,blackframe=99',
        // Detect black frames with no logo
        '[cvy5]blackframe=99',
        // Detect Newsline intro
        '[vy1][nly]blend=difference,blackframe=99',
        // Detect silences greater than MINIMUM_BOUNDARY_SILENCE_SECONDS
        `[0:1]silencedetect=n=-50dB:d=${MINIMUM_BOUNDARY_SILENCE_SECONDS}`
      ].join(';')
    ],
    ['-f', 'null'],
    '-'
  ].flat();

const findSilences = (ffmpegLines: Array<string>): Array<Silence> =>
  ffmpegLines
    .map((line) => line.match(SILENCEDETECT_FILTER_OUTPUT_PATTERN))
    .filter((x) => x)
    .map(({ groups: { endTime, duration } }) => ({
      startTime: Math.round((parseFloat(endTime) - parseFloat(duration)) * 1000),
      endTime: Math.round(parseFloat(endTime) * 1000)
    }));

const findBlackframeGroups = (
  ffmpegLines: Array<string>,
  strategy: FrameSearchStrategy,
  candidateWindows: IntervalTree<number> = new IntervalTree<number>()
): Array<DetectedFeature> =>
  ffmpegLines
    .map((line) => line.match(BLACKFRAME_FILTER_OUTPUT_PATTERN))
    .filter((x) => x)
    .map(
      ({ groups: { filterNum, frame, time } }) =>
        ({
          filterNum: parseInt(filterNum),
          frameNum: parseInt(frame),
          time: Math.round(parseFloat(time) * 1000)
        } as BlackframeOutput)
    )
    .filter(({ filterNum }) => strategy.filters.includes(filterNum))
    .filter(
      ({ time }) =>
        head(candidateWindows.search(time, time)) ?? 0 >= (strategy.minSilenceSeconds ?? 0)
    )
    .sort(compareFunc(['filterNum', 'frame']))
    .reduce((frameGroups, frame) => {
      const frameGroup = last(frameGroups) ?? [];
      if (!frameGroup.length) {
        frameGroups.push(frameGroup);
      }

      const lastFrame = last(frameGroup);
      if (
        !lastFrame ||
        (frame.frameNum - lastFrame.frameNum <= (strategy.maxSkip ?? 1) &&
          frame.filterNum === lastFrame.filterNum)
      ) {
        frameGroup.push(frame);
      } else {
        frameGroups.push([frame]);
      }
      return frameGroups;
    }, [] as Array<Array<BlackframeOutput>>)
    .filter((frameGroup) => frameGroup.length >= strategy.minFrames)
    .map(
      (frameGroup) =>
        ({
          start: head(frameGroup).time,
          end: last(frameGroup).time,
          firstFrame: head(frameGroup).frameNum,
          lastFrame: last(frameGroup).frameNum
        } as DetectedFeature)
    );

export const detectPotentialBoundaries = async (
  path: string,
  from: number,
  limit?: number
): Promise<Array<DetectedFeature>> => {
  const args = getFfmpegBoundaryDetectionArguments(path, from, limit);

  logger.debug(`Invoking ffmpeg with args: ${args.join(' ')}`);

  const ffmpegStartTime = process.hrtime.bigint();
  const { stderr: outputLines } = await execute('ffmpeg', args);
  const ffmpegDuration = process.hrtime.bigint() - ffmpegStartTime;
  logger.info(`Done in ${ffmpegDuration / 1_000_000n} ms`);

  const silences = findSilences(outputLines);
  logger.debug(`Found ${silences.length} silences`, silences);

  if (silences.length === 0) {
    logger.info('No silences of sufficient length, terminating boundary search');
    return [];
  }

  const candidateWindows = silences.reduce((tree, silence) => {
    tree.insert(silence.startTime, silence.endTime, silence.endTime - silence.startTime);
    return tree;
  }, new IntervalTree<number>());

  for (const strategy of BOUNDARY_STRATEGIES) {
    logger.debug(`Searching for candidates using ${strategy.name} strategy`);
    const candidates = findBlackframeGroups(outputLines, strategy, candidateWindows);
    logger.debug(`Found ${candidates.length} boundary candidates`, candidates);
    if (candidates.length > 0) {
      return candidates;
    }
  }

  return [];
};

const getFfmpegNewsBannerDetectionArguments = (path: string): Array<string> =>
  [
    config.threadLimit > 0 ? ['-threads', `${config.threadLimit}`] : [],
    ['-i', path],
    ['-i', join(appRootPath.path, 'data/news_background.jpg')],
    [
      '-filter_complex',
      [
        'nullsrc=size=184x800:r=29.97[base]',
        // Extract luma channels
        '[0:0]extractplanes=y[vy]',
        '[1]extractplanes=y[iy]',
        '[vy]split=2[vy0][vy1]',
        '[iy]split=2[iy0][iy1]',
        // Crop left and right margin areas
        '[vy0]crop=92:800:0:174[vyl]',
        '[vy1]crop=92:800:1828:174[vyr]',
        '[iy0]crop=92:800:0:174[iyl]',
        '[iy1]crop=92:800:1828:174[iyr]',
        // Compare left and right margins with news banner background
        '[vyl][iyl]blend=difference[dl]',
        '[vyr][iyr]blend=difference[dr]',
        '[base][dl]overlay=0:0:shortest=1[ol]',
        '[ol][dr]overlay=92:0,blackframe=99:16'
      ].join(';')
    ],
    ['-f', 'null'],
    '-'
  ].flat();

export const detectNewsBanners = async (path: string): Promise<Array<DetectedFeature>> => {
  const args = getFfmpegNewsBannerDetectionArguments(path);

  logger.debug(`Invoking ffmpeg with args: ${args.join(' ')}`);
  const ffmpegStartTime = process.hrtime.bigint();
  const { stderr: outputLines } = await execute('ffmpeg', args);
  const ffmpegDuration = process.hrtime.bigint() - ffmpegStartTime;
  logger.info(`Done in ${ffmpegDuration / 1_000_000n} ms`);

  const newsBanners = findBlackframeGroups(outputLines, NEWS_BANNER_STRATEGY);
  return newsBanners;
};

const getFfmpegCropDetectionArguments = (path: string, from: number, limit: number) =>
  [
    '-copyts',
    config.threadLimit > 0 ? ['-threads', `${config.threadLimit}`] : [],
    ['-ss', `${from / 1000}`],
    ['-t', `${limit / 1000}`],
    ['-i', path],
    ['-i', join(appRootPath.path, 'data/news_background.jpg')],
    [
      '-filter_complex',
      [
        // Extract luma channels
        '[0:0]extractplanes=y[vy]',
        '[1]extractplanes=y[iy]',
        // Find difference with news background
        // Use input-relative crop (iw/ih) to keep the same region independent of resolution.
        // ih*928/1080 approximates the original 928px (on 1080p); ih*60/1080 is the top offset.
        '[vy][iy]blend=difference,crop=iw:floor(ih*928/1080):0:floor(ih*60/1080),split=2[vc0][vc1]',
        // Mirror content to get symmetrical crop
        '[vc0]hflip[vf]',
        '[vf][vc1]blend=addition,cropdetect=24:2:1'
      ].join(';')
    ],
    ['-f', 'null'],
    '-'
  ].flat();

export const detectCropArea = async (path: string, from: number, limit: number) => {
  const args = getFfmpegCropDetectionArguments(path, from, limit);

  logger.debug(`Invoking ffmpeg with args: ${args.join(' ')}`);
  const ffmpegStartTime = process.hrtime.bigint();
  const { stderr: outputLines } = await execute('ffmpeg', args);
  const ffmpegDuration = process.hrtime.bigint() - ffmpegStartTime;
  logger.info(`Done in ${ffmpegDuration / 1_000_000n} ms`);

  return outputLines
    .map((line) => line.match(CROPDETECT_FILTER_OUTPUT_PATTERN))
    .filter((x) => x)
    .map(({ groups: { width, time } }) => ({
      time: parseFloat(time) * 1000,
      width: parseInt(width)
    }));
};

const getFfmpegCaptureArguments = (
  path: string,
  programme: Programme,
  thumbnail: boolean,
  durationSeconds: number
): Array<string> =>
  [
    '-y',
    config.threadLimit > 0 ? ['-threads', `${config.threadLimit}`] : [],
    ['-i', config.streamUrl],
    thumbnail
      ? [
          ['-i', '-'],
          ['-map', '0'],
          ['-map', '1'],
          ['-disposition:v:1', 'attached_pic']
        ]
      : [],
    ['-t', `${durationSeconds}`],
    ['-codec', 'copy'],
    ['-f', 'mp4'],
    programme.title ? ['-metadata', `show=${programme.title}`] : [],
    programme.subtitle ? ['-metadata', `title=${programme.subtitle}`] : [],
    programme.description ? ['-metadata', `description=${programme.description}`] : [],
    programme.content ? ['-metadata', `synopsis=${programme.content}`] : [],
    programme.startDate ? ['-metadata', `date=${programme.startDate.toISOString()}`] : [],
    programme.airingId ? ['-metadata', `episode_id=${programme.airingId}`] : [],
    ['-metadata', 'network=NHK World'],
    path
  ].flat(2);

export const captureStream = async (
  path: string,
  targetSeconds: number,
  programme: Programme,
  thumbnailData: Buffer | null
): Promise<Array<string>> => {
  const args = getFfmpegCaptureArguments(path, programme, !!thumbnailData, targetSeconds);

  const thumbnailStream = thumbnailData ? Readable.from(thumbnailData) : null;

  logger.debug(`Invoking ffmpeg with args: ${args.join(' ')}`);
  const ffmpegStartTime = process.hrtime.bigint();
  const { stderr: outputLines } = await execute('ffmpeg', args, thumbnailStream);
  const ffmpegDuration = process.hrtime.bigint() - ffmpegStartTime;
  logger.info(`Done in ${ffmpegDuration / 1_000_000n} ms`);

  return outputLines;
};

// Produces an ffmpeg 'if' expression for a time-varying value derived from crop width.
// defaultWidth binds computations to the actual output width rather than a hardcoded 1920.
const generateTimeSequence = (
  calcValue: (w: number) => number,
  cropParameters: Array<CropParameters>,
  defaultWidth: number
) => {
  const { time, width = defaultWidth } = last(cropParameters) ?? {};
  if (!time) {
    return `${calcValue(width)}`;
  }

  return `if(gte(t,${time / 1000}),${calcValue(width)},${generateTimeSequence(
    calcValue,
    init(cropParameters),
    defaultWidth
  )})`;
};

// Factory: compute scaled width for a given crop width, bound to a dynamic target width.
const makeCalculateScaleWidth = (outputWidth: number) => (cropWidth: number): number =>
  Math.round((outputWidth * outputWidth) / cropWidth / 2) * 2;

// Factory: compute horizontal overlay offset to center within the dynamic target width.
const makeCalculateOverlayPosition = (outputWidth: number) => (cropWidth: number): number =>
  Math.round((cropWidth - outputWidth) / 2);

// Build the filter graph using the actual input dimensions to avoid 1920x1080 assumptions.
const generateFilterChain = (
  start: number,
  cropParameters: Array<CropParameters>,
  hasThumbnail: boolean,
  targetWidth: number,
  targetHeight: number
): Array<string> => {
  // Bind calculators to the dynamic output width.
  const calcPos = makeCalculateOverlayPosition(targetWidth);
  const calcScale = makeCalculateScaleWidth(targetWidth);
  const filters = [
    cropParameters.length > 0
      ? [
          // Initialize a base canvas at the actual resolution (not hardcoded 1920x1080).
          `nullsrc=size=${targetWidth}x${targetHeight}:r=29.97[base]`,
          // Dynamically shift overlay horizontally over time using computed offsets.
          `[base][0:0]overlay='${generateTimeSequence(
            calcPos,
            cropParameters,
            targetWidth
          )}':0:shortest=1[o]`,
          // Dynamically scale to match target width over time; keep height auto and even.
          `[o]scale='${generateTimeSequence(
            calcScale,
            cropParameters,
            targetWidth
          )}':-1:eval=frame:flags=bicubic[s]`,
          // Ensure final output is exactly targetWidth x targetHeight.
          `[s]crop=${targetWidth}:${targetHeight}:0:0[c]`
        ]
      : [],
    hasThumbnail ? `[1:2]setpts=PTS+${start / 1000}/TB[tn]` : []
  ]
    .flat()
    .join(';');

  return filters ? ['-filter_complex', filters] : [];
};

// Build ffmpeg args for post-processing using dynamic dimensions.
const getFfmpegPostProcessArguments = (
  inputPath: string,
  outputPath: string,
  start: number,
  end: number,
  cropParameters: Array<CropParameters>,
  hasThumbnail: boolean,
  targetWidth: number,
  targetHeight: number
): Array<string> =>
  [
    '-y',
    config.threadLimit > 0 ? ['-threads', `${config.threadLimit}`] : [],
    ['-i', inputPath],
    hasThumbnail ? ['-i', inputPath] : [],
    ['-ss', `${start / 1000}`],
    end ? ['-to', `${end / 1000}`] : [],
    ['-codec', 'copy'],
    // Build filter graph sized to the probed input dimensions.
    generateFilterChain(start, cropParameters, hasThumbnail, targetWidth, targetHeight),
    cropParameters.length > 0
      ? [
          ['-map', '[c]'],
          ['-crf', '19'],
          ['-preset', 'veryfast'],
          ['-codec:v:0', 'libx264']
        ]
      : ['-map', '0:0'],
    ['-map', '0:1'],
    hasThumbnail
      ? [
          ['-map', '[tn]'],
          ['-codec:v:1', 'mjpeg'],
          ['-disposition:v:1', 'attached_pic']
        ]
      : [],
    ['-map_metadata', '0'],
    ['-f', 'mp4'],
    outputPath
  ].flat(2);

export const postProcessRecording = async (
  inputPath: string,
  outputPath: string,
  start: number,
  end: number,
  cropParameters: Array<CropParameters>
): Promise<void> => {
  const hasThumbnail = (await getStreamCount(inputPath)) > 2;
  // Probe input dimensions to avoid hardcoded 1920x1080; keep safe defaults if probing fails.
  let targetWidth = FULL_CROP_WIDTH;
  let targetHeight = 1080;
  try {
    const dims = await getVideoDimensions(inputPath);
    targetWidth = dims.width;
    targetHeight = dims.height;
  } catch (err) {
    logger.warn(
      `Unable to determine video dimensions; falling back to ${targetWidth}x${targetHeight}`
    );
  }

  const args = getFfmpegPostProcessArguments(
    inputPath,
    outputPath,
    start,
    end,
    cropParameters,
    hasThumbnail,
    targetWidth,
    targetHeight
  );

  logger.debug(`Invoking ffmpeg with args: ${args.join(' ')}`);
  const ffmpegStartTime = process.hrtime.bigint();
  await execute('ffmpeg', args);
  const ffmpegDuration = process.hrtime.bigint() - ffmpegStartTime;
  logger.info(`Done in ${ffmpegDuration / 1_000_000n} ms`);
};
