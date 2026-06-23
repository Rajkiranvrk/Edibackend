import { Request, Response, NextFunction } from 'express';
import path from 'path';
import { dbGet, dbRun } from '../config/database';
import { ensureDirectoryExists, uploadFolderPath as getUploadFolderPath } from '../config/storage';

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    username: string;
    account_id?: string | null;
    folder_path: string;
  };
}

export const authenticateApiKey = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  const apiKey = req.headers['x-api-key'] || req.query.api_key;

  if (!apiKey || typeof apiKey !== 'string') {
    return res.status(401).json({
      success: false,
      error: {
        code: 'MISSING_API_KEY',
        message: 'Authentication failed. Please provide a valid X-API-KEY header or api_key query parameter.'
      }
    });
  }

  try {
    const user = await dbGet<{ id: string; username: string; account_id: string | null; folder_path: string }>(
      'SELECT id, username, account_id, folder_path FROM users WHERE api_key = ?',
      [apiKey]
    );

    if (!user) {
      return res.status(401).json({
        success: false,
        error: {
          code: 'INVALID_API_KEY',
          message: 'Authentication failed. The provided API key is invalid or has expired.'
        }
      });
    }

    const normalizedFolderPath = getUploadFolderPath(user.id);
    if (path.resolve(user.folder_path) !== path.resolve(normalizedFolderPath)) {
      await dbRun('UPDATE users SET folder_path = ? WHERE id = ?', [normalizedFolderPath, user.id]);
      ensureDirectoryExists(normalizedFolderPath);
      user.folder_path = normalizedFolderPath;
    }

    req.user = user;
    next();
  } catch (error: any) {
    console.error('Authentication middleware error:', error);
    
    // Provide an extremely helpful diagnostic message if the database connection failed
    const isConnError = error.message?.toLowerCase().includes('connect') || 
                        error.message?.toLowerCase().includes('login') ||
                        error.code === 'ELOGIN';

    if (isConnError) {
      return res.status(503).json({
        success: false,
        error: {
          code: 'DATABASE_CONNECTION_ERROR',
          message: 'Unable to connect to local Microsoft SQL Server. Please make sure SQL Server is running and your credentials in backend/.env are correct.',
          details: error.message
        }
      });
    }

    return res.status(500).json({
      success: false,
      error: {
        code: 'SERVER_ERROR',
        message: 'Internal server error during authentication.',
        details: error.message
      }
    });
  }
};
