import express from 'express';
import cors from 'cors';
import { initializeDatabase } from './config/database';
import ediRoutes from './routes/edi';
import authRoutes from './routes/auth';
import { startFolderWatcher, stopFolderWatcher } from './workers/watcher';

const app = express();
const PORT = process.env.PORT || 5000;

// Enable CORS so the React app can consume resources
app.use(cors({
  origin: '*', // In production, customize this to your front-end host
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-KEY']
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Test Server Health
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', timestamp: new Date() });
});

// Auth Routes (Register, Login)
app.use('/api/v1/auth', authRoutes);

// EDI Core Routes (requires X-API-KEY)
app.use('/api/v1/edi', ediRoutes);

// Database initialization state
let dbInitialized = false;

// If running in serverless/Vercel, initialize database lazily on first request
if (process.env.VERCEL) {
  app.use(async (req, res, next) => {
    if (req.path === '/health') {
      return next();
    }
    if (!dbInitialized) {
      try {
        await initializeDatabase();
        dbInitialized = true;
        console.log('Lazy database initialization complete on Vercel.');
      } catch (err) {
        console.error('Lazy database initialization failed on Vercel:', err);
        return res.status(500).json({
          success: false,
          error: { code: 'DATABASE_INIT_FAILED', message: 'Failed to initialize database' }
        });
      }
    }
    next();
  });
}

if (!process.env.VERCEL) {
  // Bootstrapping function for local execution
  const startServer = async () => {
    try {
      console.log('Starting system initialization...');
      
      // 1. Setup SQLite database schemas
      await initializeDatabase();
      console.log('Database initialization complete.');

      // 2. Start folder monitoring daemon
      startFolderWatcher();

      // 3. Bind port and start Express listener
      app.listen(PORT, () => {
        console.log(`====================================================`);
        console.log(`🚀 EDI API Server is listening on http://localhost:${PORT}`);
        console.log(`🛡️  Web API Authentication via X-API-KEY header enabled`);
        console.log(`====================================================`);
      });
    } catch (error) {
      console.error('Fatal: Failed to start EDI system:', error);
      process.exit(1);
    }
  };

  // Handle process shutdown cleanly
  const handleShutdown = () => {
    console.log('Shutting down API server gracefully...');
    stopFolderWatcher();
    process.exit(0);
  };

  process.on('SIGINT', handleShutdown);
  process.on('SIGTERM', handleShutdown);

  startServer();
}

export default app;
