import { Router, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { authenticateApiKey, AuthenticatedRequest } from '../middleware/auth';
import { dbAll, dbGet, dbRun } from '../config/database';
import { processEdiFile } from '../services/processor';

const router = Router();

// Configure Multer to upload files directly into the authenticated user's folder
const storage = multer.diskStorage({
  destination: (req: AuthenticatedRequest, file, cb) => {
    if (!req.user) {
      return cb(new Error('User context missing. Authentication failed.'), '');
    }
    const userFolder = req.user.folder_path;
    if (!fs.existsSync(userFolder)) {
      fs.mkdirSync(userFolder, { recursive: true });
    }
    cb(null, userFolder);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}_${file.originalname}`);
  }
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/xml' || file.mimetype === 'application/xml' || file.originalname.toLowerCase().endsWith('.xml')) {
      cb(null, true);
    } else {
      cb(new Error('Only XML files are permitted.'));
    }
  },
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB file size limit
});

// A. UPLOAD FILE API
// POST /api/v1/edi/upload
router.post(
  '/upload',
  authenticateApiKey,
  upload.single('file'),
  async (req: AuthenticatedRequest, res: Response) => {
    if (!req.file || !req.user) {
      return res.status(400).json({
        success: false,
        error: { code: 'UPLOAD_FAILED', message: 'No XML file provided or user context missing.' }
      });
    }

    const fileId = 'file_' + Math.random().toString(36).substring(2, 15) + '_' + Date.now();
    const filePath = req.file.path;
    const originalFilename = req.file.originalname;
    const fileSize = req.file.size;

    try {
      // 1. Log file as Uploaded in database
      await dbRun(
        `INSERT INTO edi_file_logs (file_id, user_id, account_id, original_filename, stored_path, file_size_bytes, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [fileId, req.user.id, req.user.account_id || null, originalFilename, filePath, fileSize, 'Uploaded']
      );

      // 2. Process file asynchronously
      processEdiFile(fileId).then((result) => {
        if (result.success) {
          console.log(`API Processor: Successfully ingested customs file ${fileId}`);
        } else {
          console.error(`API Processor: Failed to ingest customs file ${fileId}: ${result.error}`);
        }
      }).catch((err) => {
        console.error(`API Processor: Fatal crash processing customs file ${fileId}:`, err);
      });

      // 3. Return immediate 202 Accepted status
      return res.status(202).json({
        success: true,
        message: 'Customs declaration XML uploaded and queued for processing.',
        data: {
          file_id: fileId,
          filename: originalFilename,
          status: 'Uploaded',
          received_at: new Date().toISOString()
        }
      });

    } catch (err: any) {
      console.error('Error during file registration:', err);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      return res.status(500).json({
        success: false,
        error: { code: 'SERVER_ERROR', message: 'Internal server error while queueing file.' }
      });
    }
  }
);

// B. GET FILE STATUS API
// GET /api/v1/edi/files/:file_id
router.get('/files/:file_id', authenticateApiKey, async (req: AuthenticatedRequest, res: Response) => {
  const { file_id } = req.params;
  const userId = req.user?.id;

  try {
    const file = await dbGet(
      'SELECT file_id, user_id, original_filename, status, record_count, error_message, created_at, updated_at FROM edi_file_logs WHERE file_id = ? AND user_id = ?',
      [file_id, userId]
    );

    if (!file) {
      return res.status(404).json({
        success: false,
        error: { code: 'FILE_NOT_FOUND', message: 'EDI transaction record not found.' }
      });
    }

    return res.status(200).json({
      success: true,
      data: file
    });
  } catch (err: any) {
    console.error('Error fetching file details:', err);
    return res.status(500).json({
      success: false,
      error: { code: 'SERVER_ERROR', message: 'Internal server error fetching details.' }
    });
  }
});

// C. GET ALL FILES LOGS
// GET /api/v1/edi/files
router.get('/files', authenticateApiKey, async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user?.id;
  const status = req.query.status as string;
  const page = parseInt(req.query.page as string || '1');
  const limit = Math.min(parseInt(req.query.limit as string || '10'), 200);
  const offset = (page - 1) * limit;

  try {
    let sql = 'SELECT file_id, original_filename, status, record_count, error_message, file_size_bytes, created_at, updated_at FROM edi_file_logs WHERE user_id = ?';
    const params: any[] = [userId];

    if (status) {
      sql += ' AND status = ?';
      params.push(status);
    }

    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const files = await dbAll(sql, params);

    let countSql = 'SELECT COUNT(*) as total FROM edi_file_logs WHERE user_id = ?';
    const countParams: any[] = [userId];
    if (status) {
      countSql += ' AND status = ?';
      countParams.push(status);
    }
    const countResult = await dbGet<{ total: number }>(countSql, countParams);
    const total = countResult?.total || 0;

    return res.status(200).json({
      success: true,
      pagination: {
        total_records: total,
        total_pages: Math.ceil(total / limit),
        current_page: page,
        limit
      },
      data: files
    });
  } catch (err: any) {
    console.error('Error listing file history:', err);
    return res.status(500).json({
      success: false,
      error: { code: 'SERVER_ERROR', message: 'Internal server error fetching logs.' }
    });
  }
});

// D. GET SUMMARY STATS FOR DASHBOARD CARDS
// GET /api/v1/edi/stats
router.get('/stats', authenticateApiKey, async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user?.id;

  try {
    const stats = await dbGet<{
      total: number;
      success: number;
      failed: number;
      processing: number;
      records_ingested: number;
    }>(
      `SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 'Success' THEN 1 ELSE 0 END) as success,
        SUM(CASE WHEN status = 'Failed' THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN status = 'Processing' OR status = 'Uploaded' THEN 1 ELSE 0 END) as processing,
        SUM(CASE WHEN status = 'Success' THEN record_count ELSE 0 END) as records_ingested
       FROM edi_file_logs 
       WHERE user_id = ?`,
      [userId]
    );

    return res.status(200).json({
      success: true,
      data: {
        total: stats?.total || 0,
        success: stats?.success || 0,
        failed: stats?.failed || 0,
        processing: stats?.processing || 0,
        records_ingested: stats?.records_ingested || 0,
        success_rate: stats?.total ? Math.round(((stats.success || 0) / stats.total) * 100) : 100
      }
    });
  } catch (err: any) {
    console.error('Error fetching dashboard stats:', err);
    return res.status(500).json({
      success: false,
      error: { code: 'SERVER_ERROR', message: 'Internal server error fetching stats.' }
    });
  }
});

// E. GET NESTED INGESTED BUSINESS DATA (Parent Shipment + Child Items + CPC Codes + Invoices)
// GET /api/v1/edi/business-data
router.get('/business-data', authenticateApiKey, async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user?.id;
  const page = parseInt(req.query.page as string || '1');
  const limit = parseInt(req.query.limit as string || '10');
  const offset = (page - 1) * limit;

  try {
    // 1. Get Parent Shipments (ALL columns)
    const shipments = await dbAll<any>(
      `SELECT s.*, f.original_filename 
       FROM shipments_ingested s
       JOIN edi_file_logs f ON s.file_id = f.file_id
       WHERE f.user_id = ?
       ORDER BY s.ingested_at DESC
       LIMIT ? OFFSET ?`,
      [userId, limit, offset]
    );

    // 2. Fetch all child records for each Shipment
    for (const shpt of shipments) {
      // Child Items (all columns)
      const items = await dbAll(
        'SELECT * FROM shipment_items_ingested WHERE hawb = ?',
        [shpt.hawb]
      );
      shpt.items = items;

      // CPC Codes
      const cpcCodes = await dbAll(
        'SELECT * FROM shipment_cpc_codes WHERE hawb = ?',
        [shpt.hawb]
      );
      shpt.cpc_codes = cpcCodes;

      // Invoices
      const invoices = await dbAll(
        'SELECT * FROM shipment_invoices WHERE hawb = ?',
        [shpt.hawb]
      );
      shpt.invoices = invoices;
    }

    const countResult = await dbGet<{ total: number }>(
      `SELECT COUNT(*) as total 
       FROM shipments_ingested s
       JOIN edi_file_logs f ON s.file_id = f.file_id
       WHERE f.user_id = ?`,
      [userId]
    );
    const total = countResult?.total || 0;

    return res.status(200).json({
      success: true,
      pagination: {
        total_records: total,
        total_pages: Math.ceil(total / limit),
        current_page: page
      },
      data: shipments
    });
  } catch (err: any) {
    console.error('Error listing business data:', err);
    return res.status(500).json({
      success: false,
      error: { code: 'SERVER_ERROR', message: 'Internal server error fetching business data.' }
    });
  }
});

// F. GET ACTIVE API KEY
// GET /api/v1/edi/key-info
router.get('/key-info', authenticateApiKey, async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user?.id;

  try {
    const keyDetails = await dbGet<{ api_key: string }>(
      'SELECT api_key FROM users WHERE id = ?',
      [userId]
    );

    return res.status(200).json({
      success: true,
      data: {
        user_id: userId,
        api_key: keyDetails?.api_key || 'Secret'
      }
    });
  } catch (err: any) {
    console.error('Error fetching key info:', err);
    return res.status(500).json({
      success: false,
      error: { code: 'SERVER_ERROR', message: 'Internal server error fetching credentials.' }
    });
  }
});

export default router;
