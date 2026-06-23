import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();

export const storageRoot = process.env.STORAGE_ROOT || path.join(__dirname, '..', '..', 'storage');

export const ensureDirectoryExists = (dirPath: string) => {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
};

export const uploadFolderPath = (userId: string) => path.join(storageRoot, 'uploads', userId);
export const archiveFolderPath = (userId: string) => path.join(storageRoot, 'archive', userId);
export const errorFolderPath = (userId: string) => path.join(storageRoot, 'errors', userId);
export const samplesFolderPath = () => path.join(storageRoot, 'samples');

export const normalizeUserFolderPath = (userId: string, currentFolderPath?: string) => {
  const expected = uploadFolderPath(userId);
  if (!currentFolderPath) return expected;
  return path.resolve(currentFolderPath) === path.resolve(expected) ? expected : expected;
};

export const ensureUserUploadFolder = (userId: string, currentFolderPath?: string) => {
  const folderPath = normalizeUserFolderPath(userId, currentFolderPath);
  ensureDirectoryExists(folderPath);
  return folderPath;
};
