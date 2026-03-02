import fs from 'fs';
import path from 'path';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';

/**
 * Save media to the group's workspace folder.
 * Returns the filename of the saved file.
 */
export async function saveMedia(
  groupFolder: string,
  buffer: Buffer,
  extension: string,
  prefix = 'media',
): Promise<string> {
  try {
    const groupDir = resolveGroupFolderPath(groupFolder);
    const mediaDir = path.join(groupDir, 'media');

    if (!fs.existsSync(mediaDir)) {
      fs.mkdirSync(mediaDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${prefix}_${timestamp}${extension}`;
    const filePath = path.join(mediaDir, filename);

    fs.writeFileSync(filePath, buffer);
    logger.info({ groupFolder, filename }, 'Media saved to workspace');

    return filename;
  } catch (err) {
    logger.error({ err, groupFolder }, 'Failed to save media');
    throw err;
  }
}
