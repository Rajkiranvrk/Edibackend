import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { dbRun, dbGet } from '../config/database';
import { ensureDirectoryExists, uploadFolderPath as getUploadFolderPath } from '../config/storage';

const router = Router();

// Helper: generate a secure unique API key
const generateApiKey = (username: string): string => {
  const hash = crypto
    .createHash('sha256')
    .update(username + Date.now() + Math.random().toString())
    .digest('hex')
    .substring(0, 32);
  return `edi_key_${hash}`;
};

// Helper: generate a unique user ID
const generateUserId = (username: string): string => {
  return username.toLowerCase().replace(/\s+/g, '_') + '_' + Date.now().toString(36);
};

// Diagnostic helper
const handleDbError = (err: any, res: Response, context: string) => {
  console.error(`[DB Error] ${context}:`, err);
  const isConnError = err.message?.toLowerCase().includes('connect') || 
                      err.message?.toLowerCase().includes('login') ||
                      err.code === 'ELOGIN';

  if (isConnError) {
    return res.status(503).json({
      success: false,
      error: { 
        code: 'DATABASE_CONNECTION_ERROR', 
        message: 'Could not connect to MS SQL Server. Please check that your SQL Server is running and credentials in backend/.env match.',
        details: err.message
      }
    });
  }

  return res.status(500).json({
    success: false,
    error: { 
      code: 'SERVER_ERROR', 
      message: `Internal server error during ${context}.`,
      details: err.message
    }
  });
};

// A. REGISTER A NEW USER
// POST /api/v1/auth/register
router.post('/register', async (req: Request, res: Response) => {
  const { username, accountId } = req.body;

  if (!username || username.trim().length < 3) {
    return res.status(400).json({
      success: false,
      error: { code: 'INVALID_INPUT', message: 'Username is required and must be at least 3 characters.' }
    });
  }

  const cleanUsername = username.trim();
  const cleanAccountId = accountId && String(accountId).trim().length > 0 ? String(accountId).trim() : null;

  try {
    // 1. Check if username already exists
    const existing = await dbGet<{ id: string }>(
      'SELECT id FROM users WHERE username = ?',
      [cleanUsername]
    );

    if (existing) {
      return res.status(409).json({
        success: false,
        error: { code: 'USERNAME_TAKEN', message: `Username '${cleanUsername}' is already registered.` }
      });
    }

    // 2. Generate unique user ID and API Key
    const userId = generateUserId(cleanUsername);
    const apiKey = generateApiKey(cleanUsername);

    // 3. Create the user's isolated upload folder on disk
    const uploadFolderPath = getUploadFolderPath(userId);
    ensureDirectoryExists(uploadFolderPath);

    // 4. Insert user into database
    await dbRun(
      'INSERT INTO users (id, username, account_id, api_key, folder_path) VALUES (?, ?, ?, ?, ?)',
      [userId, cleanUsername, cleanAccountId, apiKey, uploadFolderPath]
    );

    console.log(`[Registration] New user registered: ${cleanUsername} | ID: ${userId} | accountId: ${cleanAccountId}`);
    console.log(`[Registration] Upload folder created: ${uploadFolderPath}`);

    return res.status(201).json({
      success: true,
      message: `User '${cleanUsername}' registered successfully.`,
      data: {
        user_id: userId,
        username: cleanUsername,
        account_id: cleanAccountId,
        api_key: apiKey,
        upload_folder: uploadFolderPath,
        registered_at: new Date().toISOString(),
        instructions: {
          step1: `Store your API key securely. It will NOT be shown again.`,
          step2: `Include this header in all API requests: X-API-KEY: ${apiKey}`,
          step3: `Upload files to: POST http://localhost:5000/api/v1/edi/upload`,
          step4: `Or drop XML files directly into your upload folder: ${uploadFolderPath}`
        }
      }
    });
  } catch (err: any) {
    return handleDbError(err, res, 'registration');
  }
});

// B. LOGIN / GET API KEY (using username)
// POST /api/v1/auth/login
router.post('/login', async (req: Request, res: Response) => {
  const { username } = req.body;

  if (!username || username.trim().length === 0) {
    return res.status(400).json({
      success: false,
      error: { code: 'INVALID_INPUT', message: 'Username is required.' }
    });
  }

  try {
    const user = await dbGet<{ id: string; username: string; account_id: string; api_key: string; folder_path: string; created_at: string }>(
      'SELECT id, username, account_id, api_key, folder_path, created_at FROM users WHERE username = ?',
      [username.trim()]
    );

    if (!user) {
      return res.status(404).json({
        success: false,
        error: { code: 'USER_NOT_FOUND', message: `No user found with username '${username}'.` }
      });
    }

    const normalizedFolderPath = getUploadFolderPath(user.id);
    if (path.resolve(user.folder_path) !== path.resolve(normalizedFolderPath)) {
      await dbRun('UPDATE users SET folder_path = ? WHERE id = ?', [normalizedFolderPath, user.id]);
      ensureDirectoryExists(normalizedFolderPath);
      user.folder_path = normalizedFolderPath;
    }

    return res.status(200).json({
      success: true,
      message: 'Login successful.',
      data: {
        user_id: user.id,
        username: user.username,
        account_id: user.account_id,
        api_key: user.api_key,
        upload_folder: user.folder_path,
        registered_at: user.created_at
      }
    });
  } catch (err: any) {
    return handleDbError(err, res, 'login');
  }
});

// C. LIST ALL USERS (Admin-only overview, no sensitive data)
// GET /api/v1/auth/users
router.get('/users', async (req: Request, res: Response) => {
  try {
    const { dbAll } = await import('../config/database');
    const allUsers = await dbAll<{ id: string; username: string; account_id: string; folder_path: string; created_at: string }>(
      'SELECT id, username, account_id, folder_path, created_at FROM users ORDER BY created_at DESC',
      []
    );

    return res.status(200).json({
      success: true,
      total: allUsers.length,
      data: allUsers.map(u => ({
        user_id: u.id,
        username: u.username,
        account_id: u.account_id,
        upload_folder: u.folder_path,
        registered_at: u.created_at
      }))
    });
  } catch (err: any) {
    return handleDbError(err, res, 'fetching users');
  }
});

export default router;
