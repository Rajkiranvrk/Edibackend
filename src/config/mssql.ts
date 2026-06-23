import mssql from 'mssql';
import dotenv from 'dotenv';
import path from 'path';
import { uploadFolderPath } from './storage';

// Load environmental variables
dotenv.config();

export const sqlConfig: mssql.config = {
  user: process.env.MSSQL_USER || 'sa',
  password: process.env.MSSQL_PASSWORD || 'YourStrongPassword123',
  server: process.env.MSSQL_SERVER || 'localhost',
  database: process.env.MSSQL_DATABASE || 'edi_db',
  port: parseInt(process.env.MSSQL_PORT || '1433', 10),
  options: {
    encrypt: process.env.MSSQL_ENCRYPT === 'true' || true,
    trustServerCertificate: process.env.MSSQL_TRUST_CERT === 'false' ? false : true,
  },
  pool: {
    max: 10,
    min: 0,
    idleTimeoutMillis: 30000
  }
};

let pool: mssql.ConnectionPool | null = null;

// Connect to MS SQL Server
export const connectMssql = async (): Promise<mssql.ConnectionPool> => {
  if (pool) return pool;
  try {
    pool = await mssql.connect(sqlConfig);
    console.log(`🔌 Connected to Microsoft SQL Server (${sqlConfig.server}/${sqlConfig.database}) successfully.`);
    return pool;
  } catch (err) {
    console.error('❌ SQL Server connection failed. Make sure your local SQL Server is running and credentials match.');
    console.error(err);
    throw err;
  }
};

// Initialize MS SQL Database Tables
export const initializeMssqlDatabase = async () => {
  try {
    const activePool = await connectMssql();
    
    // 1. Create Users Table
    await activePool.request().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='users' AND xtype='U')
      BEGIN
          CREATE TABLE users (
              id VARCHAR(100) PRIMARY KEY,
              username VARCHAR(150) NOT NULL UNIQUE,
              account_id VARCHAR(100),
              api_key VARCHAR(100) NOT NULL UNIQUE,
              folder_path VARCHAR(500) NOT NULL,
              created_at DATETIME DEFAULT GETDATE()
          );
          PRINT 'Created table: users';
      END
    `);

    await activePool.request().query(`
      IF EXISTS (SELECT * FROM sysobjects WHERE name='users' AND xtype='U')
      AND NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='users' AND COLUMN_NAME='account_id')
      BEGIN
          ALTER TABLE users ADD account_id VARCHAR(100);
          PRINT 'Altered table: users added account_id';
      END
    `);

    // 2. Create EDI File Logs Table
    await activePool.request().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='edi_file_logs' AND xtype='U')
      BEGIN
          CREATE TABLE edi_file_logs (
              file_id VARCHAR(100) PRIMARY KEY,
              user_id VARCHAR(100) NOT NULL,
              account_id VARCHAR(100),
              original_filename VARCHAR(255) NOT NULL,
              stored_path VARCHAR(500) NOT NULL,
              file_size_bytes BIGINT NOT NULL,
              status VARCHAR(50) NOT NULL,
              record_count INT DEFAULT 0,
              error_message NVARCHAR(MAX),
              created_at DATETIME DEFAULT GETDATE(),
              updated_at DATETIME DEFAULT GETDATE(),
              CONSTRAINT FK_FileLogs_Users FOREIGN KEY (user_id) REFERENCES users(id)
          );
          PRINT 'Created table: edi_file_logs';
      END
    `);

    await activePool.request().query(`
      IF EXISTS (SELECT * FROM sysobjects WHERE name='edi_file_logs' AND xtype='U')
      AND NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='edi_file_logs' AND COLUMN_NAME='account_id')
      BEGIN
          ALTER TABLE edi_file_logs ADD account_id VARCHAR(100);
          PRINT 'Altered table: edi_file_logs added account_id';
      END
    `);

    // 3. Create Shipments Ingested Table — ALL tags from Comm + ShipmentHeader
    await activePool.request().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='shipments_ingested' AND xtype='U')
      BEGIN
          CREATE TABLE shipments_ingested (
              id INT IDENTITY(1,1) PRIMARY KEY,
              hawb VARCHAR(100) NOT NULL UNIQUE,
              file_id VARCHAR(100) NOT NULL,

              -- Comm section
              doc_type VARCHAR(100),
              doc_version VARCHAR(20),
              sender_org_id VARCHAR(100),
              receiver_org_id VARCHAR(100),
              comm_datetime VARCHAR(50),

              -- Shipment Header scalar fields
              job_no VARCHAR(100),
              job_date VARCHAR(50),
              msg_type VARCHAR(50),
              decl_type VARCHAR(50),
              packing_type VARCHAR(50),
              place_of_release VARCHAR(10),
              loc_for_release NVARCHAR(500),
              place_of_receipt VARCHAR(10),
              loc_for_receipt NVARCHAR(500),

              -- Importer / Exporter
              imp_exp_cr_no VARCHAR(100),
              importer_name NVARCHAR(500),
              exp_city_name NVARCHAR(200),
              exp_postal_code VARCHAR(50),
              exp_ctry_code VARCHAR(10),

              -- Consignee
              consignee_name NVARCHAR(500),
              consignee_name2 NVARCHAR(500),
              consignee_street NVARCHAR(500),
              consignee_post_box NVARCHAR(500),
              consignee_city NVARCHAR(200),
              consignee_sub_div_code VARCHAR(100),
              consignee_sub_div_name NVARCHAR(200),
              consignee_postal_code VARCHAR(50),
              consignee_ctry_code VARCHAR(10),

              -- End User
              end_user_name NVARCHAR(500),
              end_user_street NVARCHAR(500),
              end_user_post_box NVARCHAR(500),
              end_user_city NVARCHAR(200),
              end_user_sub_div_code VARCHAR(100),
              end_user_sub_div_name NVARCHAR(200),
              end_user_postal_code VARCHAR(50),
              end_user_ctry_code VARCHAR(10),

              -- Totals & Logistics
              transport_mode VARCHAR(20),
              ctry_final_dest VARCHAR(10),
              declared_value DECIMAL(18, 2),
              total_weight DECIMAL(18, 4),
              total_weight_unit VARCHAR(10),
              total_pieces INT,
              total_pieces_unit VARCHAR(10),
              remark NVARCHAR(MAX),

              ingested_at DATETIME DEFAULT GETDATE(),
              CONSTRAINT FK_Shipments_FileLogs FOREIGN KEY (file_id) REFERENCES edi_file_logs(file_id)
          );
          PRINT 'Created table: shipments_ingested';
      END
    `);

    // 4. Create OutHeaderTbl for external header metadata
    await activePool.request().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='OutHeaderTbl' AND xtype='U')
      BEGIN
          CREATE TABLE OutHeaderTbl (
              id INT IDENTITY(1,1) PRIMARY KEY,
              Refid VARCHAR(100),
              JobId VARCHAR(100),
              MSGId VARCHAR(100),
              PermitId VARCHAR(100),
              TradeNetMailboxID VARCHAR(100)
          );
          PRINT 'Created table: OutHeaderTbl';
      END
    `);

    // 5. Create CPC Codes Table (multiple per shipment)
    await activePool.request().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='shipment_invoices' AND xtype='U')
      BEGIN
          CREATE TABLE shipment_invoices (
              id INT IDENTITY(1,1) PRIMARY KEY,
              hawb VARCHAR(100) NOT NULL,
              invoice_no VARCHAR(100),
              invoice_date VARCHAR(50),
              term_type VARCHAR(50),
              supplier_name NVARCHAR(500),
              manu_name NVARCHAR(500),
              charge_code VARCHAR(50),
              amount DECIMAL(18, 2),
              from_curr_code VARCHAR(10),
              CONSTRAINT FK_Invoices_Shipments FOREIGN KEY (hawb) REFERENCES shipments_ingested(hawb)
          );
          PRINT 'Created table: shipment_invoices';
      END
    `);

    // 6. Create Shipment Items Ingested Table — ALL item tags
    await activePool.request().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='shipment_items_ingested' AND xtype='U')
      BEGIN
          CREATE TABLE shipment_items_ingested (
              id INT IDENTITY(1,1) PRIMARY KEY,
              hawb VARCHAR(100) NOT NULL,
              item_sno INT,
              hs_code VARCHAR(50),
              description NVARCHAR(1000),
              country_origin VARCHAR(10),
              quantity DECIMAL(18, 4),
              item_unit VARCHAR(20),
              fob_value DECIMAL(18, 2),
              item_mark VARCHAR(200),
              item_model VARCHAR(200),
              item_cat_code VARCHAR(100),
              fob_foreign_amt DECIMAL(18, 2),
              fob_foreign_curr VARCHAR(10),
              CONSTRAINT FK_ShipmentItems_Shipments FOREIGN KEY (hawb) REFERENCES shipments_ingested(hawb)
          );
          PRINT 'Created table: shipment_items_ingested';
      END
    `);

    await activePool.request().query(`
      IF EXISTS (SELECT * FROM sysobjects WHERE name='shipment_items_ingested' AND xtype='U')
      AND NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='shipment_items_ingested' AND COLUMN_NAME='item_sno')
      BEGIN
          ALTER TABLE shipment_items_ingested ADD item_sno INT;
          PRINT 'Altered table: shipment_items_ingested added item_sno';
      END
    `);

    // Seed default test user if users table is empty
    const checkUser = await activePool.request()
      .input('id', mssql.VarChar, 'test_user')
      .query('SELECT * FROM users WHERE id = @id');

    if (checkUser.recordset.length === 0) {
      const uploadPath = uploadFolderPath('test_user');
      await activePool.request()
        .input('id', mssql.VarChar, 'test_user')
        .input('username', mssql.VarChar, 'TestUser')
        .input('api_key', mssql.VarChar, 'edi_key_test_user12345')
        .input('folder_path', mssql.VarChar, uploadPath)
        .query('INSERT INTO users (id, username, api_key, folder_path) VALUES (@id, @username, @api_key, @folder_path)');
      
      console.log('Seeded default test user in SQL Server.');
    }

    console.log('✅ Microsoft SQL Server database schemas initialized.');
  } catch (err) {
    console.error('❌ Failed to initialize MS SQL tables:', err);
  }
};
