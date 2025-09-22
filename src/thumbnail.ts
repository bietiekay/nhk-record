import fetch from 'node-fetch';
import config from './config';
import logger from './logger';

export const getThumbnail = async (thumbnailUri: string): Promise<Buffer | null> => {
  const url = `${config.assetsUrl}${thumbnailUri}`;

  logger.info(`Retrieving thumbnail: ${url}`);
  try {
    const res = await fetch(url, {
      headers: {
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'accept-language': 'en-US,en;q=0.9,ja;q=0.8',
        'cache-control': 'no-cache',
        'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
      }
    });
    return await res.buffer();
  } catch (err) {
    logger.error('Failed to get thumbnail');
    logger.error(err);
  }

  return null;
};
