import fs from 'fs';
import path from 'path';
import { dbAll, dbRun, dbGet } from '../config/database';
import { processEdiFile } from '../services/processor';
import { ensureUserUploadFolder } from '../config/storage';

const SCAN_INTERVAL_MS = 5000; // Check every 5 seconds
let intervalId: NodeJS.Timeout | null = null;

// Generate unique ID for files
const generateFileId = (): string => {
  return 'file_' + Math.random().toString(36).substring(2, 15) + '_' + Date.now();
};

export const startFolderWatcher = () => {
  if (intervalId) return;

  console.log(`Starting background EDI folder watcher. Polling active every ${SCAN_INTERVAL_MS / 1000}s...`);

  intervalId = setInterval(async () => {
    try {
      // 1. Get all registered users and their directories
      const users = await dbAll<{ id: string; account_id: string | null; folder_path: string }>(
        'SELECT id, account_id, folder_path FROM users'
      );

      for (const user of users) {
        const normalizedFolder = ensureUserUploadFolder(user.id, user.folder_path);
      if (path.resolve(normalizedFolder) !== path.resolve(user.folder_path)) {
        await dbRun('UPDATE users SET folder_path = ? WHERE id = ?', [normalizedFolder, user.id]);
      }
      const userFolder = normalizedFolder;

        // Ensure user folder exists
        if (!fs.existsSync(userFolder)) {
          fs.mkdirSync(userFolder, { recursive: true });
          continue;
        }

        // 2. Read folder contents
        const files = fs.readdirSync(userFolder);

        for (const file of files) {
          const filePath = path.join(userFolder, file);
          const stat = fs.statSync(filePath);

          // Only process files, skip directories, and target XML format
          if (!stat.isFile() || !file.toLowerCase().endsWith('.xml')) {
            continue;
          }

          // 3. Check if file is already logged or processing
          // If a file is being copied, wait until file size is stable (not writing anymore)
          // Simple check: check if it's already in our logs
          const existingLog = await dbGet<{ file_id: string }>(
            'SELECT file_id FROM edi_file_logs WHERE stored_path = ?',
            [filePath]
          );

          if (existingLog) {
            // Already logged (might be processing, failed, or success but not yet moved/archived)
            continue;
          }

          console.log(`Watcher: Found new file in user folder: ${file} for user: ${user.id}`);

          // 4. Create database record
          const fileId = generateFileId();
          const fileSize = stat.size;

          await dbRun(
            `INSERT INTO edi_file_logs (file_id, user_id, account_id, original_filename, stored_path, file_size_bytes, status)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [fileId, user.id, user.account_id || null, file, filePath, fileSize, 'Uploaded']
          );

          // 5. Trigger processing asynchronously
          // We do not await this inside the loop so other files/folders are not blocked
          processEdiFile(fileId).then((result) => {
            if (result.success) {
              console.log(`Watcher: Successfully ingested file ${fileId} (${file})`);
            } else {
              console.error(`Watcher: Failed to ingest file ${fileId} (${file}): ${result.error}`);
            }
          }).catch((err) => {
            console.error(`Watcher: Fatal exception processing file ${fileId}:`, err);
          });
        }
      }
    } catch (error) {
      console.error('Error in EDI folder watcher routine:', error);
    }
  }, SCAN_INTERVAL_MS);
};

export const stopFolderWatcher = () => {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log('Background EDI folder watcher stopped.');
  }
};
