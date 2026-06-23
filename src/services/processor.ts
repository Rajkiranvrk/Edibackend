import fs from 'fs';
import path from 'path';
import { XMLParser } from 'fast-xml-parser';
import mssql from 'mssql';
import { dbGet, dbRun } from '../config/database';
import { connectMssql } from '../config/mssql';
import { archiveFolderPath, errorFolderPath } from '../config/storage';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true
});

const str = (val: any): string | null => {
  if (val === undefined || val === null || val === '') return null;
  return String(val).trim() || null;
};

const num = (val: any): number | null => {
  if (val === undefined || val === null || val === '') return null;
  const n = parseFloat(String(val));
  return isNaN(n) ? null : n;
};

const declTypeMap: Record<string, string> = {
  DRT: 'DRT : DIRECT (INCLUDING STORAGE IN FTZ)',
  TCO: 'TCO : TEMPORARY IMPORT FOR OTHER PURPOSES',
  TCR: 'TCR : TEMPORARY IMPORT FOR REPAIRS',
  APS: 'APS : APPROVED PREMISES/SCHEMES',
  TCE: 'TCE : TEMPORARY IMPORT FOR EXHIBITION/ACTIONS WITHOUT SALES',
  BKT: 'BKT : BLANKET',
  TCI: 'TCI : TEMPORARY EXPORT / RE-IMPORTED GOODS',
  TCS: 'TCS : TEMPORARY IMPORT FOR EXHIBITION/AUCTIONS WITH SALES'
};

const transportModeMap: Record<string, string> = {
  '1': '1 : Sea',
  '2': '2 : Rail',
  '3': '3 : Road',
  '4': '4 : Air',
  '5': '5 : Mail',
  '6': '6 : Multi-model(Not in use)',
  '7': '7 : Pipeline',
  N: 'N : Not Required'
};

const cargoPackTypeMap: Record<string, string> = {
  '5': '5 : Other non-Containerized',
  '9': '9 : Containerized'
};

const getDeclarationTypeDescription = (value: string | null): string | null => {
  if (!value) return null;
  const normalized = String(value).trim().toUpperCase();
  return declTypeMap[normalized] || value;
};

const getTransportModeDescription = (value: string | null): string | null => {
  if (!value) return null;
  const normalized = String(value).trim().toUpperCase();
  return transportModeMap[normalized] || value;
};

const getCargoPackTypeDescription = (value: string | null): string | null => {
  if (!value) return null;
  const normalized = String(value).trim().toUpperCase();
  return cargoPackTypeMap[normalized] || value;
};

const currentDateString = (): string => {
  const now = new Date();
  return now.toISOString().slice(0, 10).replace(/-/g, '');
};

const currentShortDateString = (): string => {
  const now = new Date();
  return now.toISOString().slice(2, 10).replace(/-/g, '');
};

const padNumber = (value: number, length: number): string => {
  return String(value).padStart(length, '0');
};

const MSGNO = async (pool: mssql.ConnectionPool, accountId: string, seqPoolNo = 0): Promise<string> => {
  const justdate = currentDateString();
  const result = await pool.request()
    .input('accountId', mssql.VarChar, accountId)
    .input('date', mssql.VarChar, justdate)
    .query("SELECT COUNT(PermitId) AS MsgID FROM PermitCount WHERE AccountId = @accountId AND TouchTime = @date");

  const MSGCount = String(result.recordset?.[0]?.MsgID ?? '0');
  if (MSGCount !== '0') {
    const count = seqPoolNo + parseInt(MSGCount, 10) + 1;
    return `${justdate}${padNumber(count, 4)}`;
  }

  const num = seqPoolNo + 1;
  return `${justdate}${padNumber(num, 4)}`;
};

const refid1 = async (pool: mssql.ConnectionPool, seqPoolNo = 0): Promise<string> => {
  const justdate = currentDateString();
  const result = await pool.request()
    .input('date', mssql.VarChar, justdate)
    .query("SELECT COUNT(PermitId) AS count FROM OutHeaderTbl WHERE MessageType='OUTDEC' AND LEFT(MSGId, 8) = @date");

  let max_po_no = String(result.recordset?.[0]?.count ?? '0');
  const endTagStartPosition = max_po_no.lastIndexOf('/');
  max_po_no = endTagStartPosition >= 0 ? max_po_no.substring(endTagStartPosition + 1) : max_po_no;

  let m_po_no = 0;
  if (max_po_no !== '') {
    m_po_no = parseInt(max_po_no, 10);
  }

  if (max_po_no !== '0') {
    m_po_no += 1;
  }

  m_po_no += seqPoolNo;
  return m_po_no.toString();
};

const PermitNO = async (pool: mssql.ConnectionPool, accountId: string, seqPoolNo = 0): Promise<string> => {
  const justdate = currentDateString();
  const result = await pool.request()
    .input('date', mssql.VarChar, justdate)
    .query("SELECT COUNT(PermitId) AS count FROM OutHeaderTbl WHERE MessageType='OUTDEC' AND LEFT(MSGId, 8) = @date");

  let max_po_no = String(result.recordset?.[0]?.count ?? '0');
  const endTagStartPosition = max_po_no.lastIndexOf('/');
  max_po_no = endTagStartPosition >= 0 ? max_po_no.substring(endTagStartPosition + 1) : max_po_no;

  let m_po_no = 0;
  if (max_po_no !== '') {
    m_po_no = parseInt(max_po_no, 10);
  }

  if (max_po_no !== '0') {
    m_po_no += 1;
  }

  m_po_no += seqPoolNo;
  return `${accountId}${justdate}${padNumber(m_po_no, 3)}`;
};

const getfinalcountryname = async (
  pool: mssql.ConnectionPool,
  ctrycode: string
): Promise<string> => {
  try {
    const result = await pool.request()
      .input('ctrycode', mssql.VarChar(100), ctrycode)
      .query(`
        SELECT TOP 1 CountryCode+' : '+Description AS Description
        FROM [Country]
        WHERE CountryCode = @ctrycode
      `);

    return result.recordset?.[0]?.Description || '';
  } catch (err) {
    console.error('Failed to fetch Finalcountryname:', err);
    return '';
  }
};

const getMailboxInfoForAccount = async (pool: mssql.ConnectionPool, accountId: string): Promise<{ mailboxId: string | null; declarantCompanyCode: string | null }> => {
  if (!accountId) {
    return { mailboxId: null, declarantCompanyCode: null };
  }

  try {
    const result = await pool.request()
      .input('accountId', mssql.VarChar, accountId)
      .query(`SELECT TOP 1 TradeNetMailboxID, Code FROM DeclarantCompany WHERE AccountID = @accountId`);

    const record = result.recordset?.[0];
    return {
      mailboxId: record?.TradeNetMailboxID ? String(record.TradeNetMailboxID).trim() : null,
      declarantCompanyCode: record?.Code ? String(record.Code).trim() : null
    };
  } catch (err) {
    console.error('Failed to fetch mailbox info from DeclarantCompany:', err);
    return { mailboxId: null, declarantCompanyCode: null };
  }
};

const ensureOutExporterExists = async (
  transaction: mssql.Transaction,
  importerName: string,
  impExpCrNo: string
): Promise<string | null> => {
  if (!importerName) return null;

  // Check if the importer name already exists in OutExporter
  const existing = await transaction.request()
    .input('importer_name', mssql.NVarChar, importerName)
    .query(`SELECT TOP 1 OutUserCode FROM OutExporter WHERE RTRIM(LTRIM(OutUserName + '' + OutUserName1)) = @importer_name`);

  if (existing.recordset.length > 0) {
    const existingCode = String(existing.recordset[0].OutUserCode || '').trim();
    console.log(`OutExporter: '${importerName}' already exists — using code '${existingCode}'.`);
    return existingCode || null;
  }

  // Not found — insert with OutUserCode = first 15 chars of importerName
  const outUserCode = importerName.substring(0, 15).trim();
  const ExpName = importerName.substring(0, 17);
  const ExpName1 = importerName.substring(17);

  await transaction.request()
    .input('out_user_code', mssql.VarChar, outUserCode)
    .input('out_user_name', mssql.NVarChar, ExpName)
    .input('out_user_name1', mssql.NVarChar, ExpName1)
    .input('out_user_cruei', mssql.VarChar, impExpCrNo)
    .query(`
      INSERT INTO OutExporter (OutUserCode, OutUserName, OutUserName1, OutUserCRUEI, Status, TouchUser, TouchTime)
      VALUES (@out_user_code, @out_user_name, @out_user_name1, @out_user_cruei, 'Active', 'EDI', GETDATE())
    `);

  console.log(`OutExporter: Inserted '${importerName}' with code '${outUserCode}'.`);
  return outUserCode;
};

const JobNO = async (pool: mssql.ConnectionPool, accountId: string, seqPoolNo = 0): Promise<string> => {
  const justdate = currentDateString();
  const result = await pool.request()
    .input('accountId', mssql.VarChar, accountId)
    .input('date', mssql.VarChar, justdate)
    .query("SELECT COUNT(PermitId) AS JobId FROM PermitCount WHERE AccountId = @accountId AND TouchTime = @date");

  const JobCount = String(result.recordset?.[0]?.JobId ?? '0');
  if (JobCount !== '0') {
    const count = seqPoolNo + parseInt(JobCount, 10) + 1;
    return `K${currentShortDateString()}${padNumber(count, 5)}`;
  }

  const num = seqPoolNo + 1;
  return `K${currentDateString()}${padNumber(num, 5)}`;
};

export const processEdiFile = async (fileId: string): Promise<{ success: boolean; error?: string }> => {
  try {
    const log = await dbGet<{
      file_id: string;
      user_id: string;
      account_id?: string | null;
      original_filename: string;
      stored_path: string;
      status: string;
    }>('SELECT file_id, user_id, account_id, original_filename, stored_path, status FROM edi_file_logs WHERE file_id = ?', [fileId]);

    if (!log) {
      return { success: false, error: 'File log entry not found in database.' };
    }

    await dbRun(
      'UPDATE edi_file_logs SET status = ?, updated_at = GETDATE() WHERE file_id = ?',
      ['Processing', fileId]
    );

    const filePath = log.stored_path;

    if (!fs.existsSync(filePath)) {
      const errorMsg = `File not found at path: ${filePath}`;
      await dbRun(
        'UPDATE edi_file_logs SET status = ?, error_message = ?, updated_at = GETDATE() WHERE file_id = ?',
        ['Failed', errorMsg, fileId]
      );
      return { success: false, error: errorMsg };
    }

    const xmlContent = fs.readFileSync(filePath, 'utf-8');
    const jsonObj = parser.parse(xmlContent);

    if (!jsonObj.FrtImport || !jsonObj.FrtImport.ShipmentHeader) {
      throw new Error("Invalid EDI layout. Root must be 'FrtImport' with a 'ShipmentHeader' node.");
    }

    const comm = jsonObj.FrtImport.Comm || {};
    const header = jsonObj.FrtImport.ShipmentHeader;

    const pool = await connectMssql();
    const seqPoolNo = 0;

    let accountId = log.account_id ? String(log.account_id).trim() : '';
    if (!accountId) {
      const userRecord = await dbGet<{ account_id?: string | null }>(
        'SELECT account_id FROM users WHERE id = ?',
        [log.user_id]
      );
      accountId = userRecord?.account_id ? String(userRecord.account_id).trim() : '';
      if (accountId) {
        await dbRun('UPDATE edi_file_logs SET account_id = ? WHERE file_id = ?', [accountId, fileId]);
      }
    }

    if (!accountId) {
      console.warn(`No account_id found for file ${fileId}; falling back to user_id for identifier generation.`);
    }

    const refid = await refid1(pool, seqPoolNo);
    const identifierAccountId = accountId || log.user_id;
    const jobferid = await JobNO(pool, identifierAccountId, seqPoolNo);
    const msgid = await MSGNO(pool, identifierAccountId, seqPoolNo);
    const permitId = await PermitNO(pool, identifierAccountId, seqPoolNo);
    const mailboxInfo = await getMailboxInfoForAccount(pool, accountId);
    const mailboxId = str(mailboxInfo.mailboxId || 'LYYO.LYYO006');
    const declarantCompanyCode = str(mailboxInfo.declarantCompanyCode || 'KTT9');

    const docType = str(comm.DocType);
    const docVersion = str(comm.Version);
    const senderOrgId = str(comm.SndOrgID);
    const receiverOrgId = str(comm.RcpOrgID);
    const commDatetime = str(comm.DateTime);

    const hawb = str(header.ShptHAWB);
    const jobNo = str(header.ShptJobNo);
    const jobDate = str(header.ShptJobDate);
    const msgType = str(header.ShptMsgType);
    const shouldInsertOutHeader = (msgType || '').toUpperCase() === 'OUTDEC';
    const declType = getDeclarationTypeDescription(str(header.ShptDeclType));
    const packingType = getCargoPackTypeDescription(str(header.ShptPackingType));
    const placeOfRelease = str(header.ShptPlaceOfRelease);
    const locForRelease = str(header.ShptLocForRelease);
    const placeOfReceipt = str(header.ShptPlaceOfReceipt);
    const locForReceipt = str(header.ShptLocForReceipt);

    const impExpCrNo = str(header.ShptImpExpCRNo);
    const importerName = str(header.ShptImpExpName1);
    const expCityName = str(header.ShptExpCityName);
    const expPostalCode = str(header.ShptExpPostalCode);
    const expCtryCode = str(header.ShptExpCtryCode);

    const consigneeName = str(header.ShptCsgnName1);
    const consigneeName2 = str(header.ShptCsgnName2);
    const consigneeStreet = str(header.ShptCsgnStreetName);
    const consigneePostBox = str(header.ShptCsgnPostBoxNo);
    const consigneeCity = str(header.ShptCsgnCityName);
    const consigneeSubDivCode = str(header.ShptCsgnSubDivCode);
    const consigneeSubDivName = str(header.ShptCsgnSubDivName);
    const consigneePostalCode = str(header.ShptCsgnPostalCode);
    const consigneeCtryCode = str(header.ShptCsgnCtryCode);

    const endUserName = str(header.ShptEndUserName);
    const endUserStreet = str(header.ShptEndUserStreetName);
    const endUserPostBox = str(header.ShptEndUserPostBoxNo);
    const endUserCity = str(header.ShptEndUserCityName);
    const endUserSubDivCode = str(header.ShptEndUserSubDivCode);
    const endUserSubDivName = str(header.ShptEndUserSubDivName);
    const endUserPostalCode = str(header.ShptEndUserPostalCode);
    const endUserCtryCode = str(header.ShptEndUserCtryCode);

    const transportMode = getTransportModeDescription(str(header.ShptTptMode));
    const ctryFinalDest = await getfinalcountryname(pool, str(header.ShptCtryFinalDest) || '');
    const declaredValue = num(header.ShptDeclValue);
    const totalWeight = num(header.ShptTtlWgt);
    const totalWeightUnit = str(header.ShptTtlWgtUnit);
    const totalPieces = num(header.ShptTtlPcs);
    const totalPiecesUnit = str(header.ShptTtlPcsUnit);
    const remark = str(header.ShptRemark);

    let cpcEntries = [];
    if (header.CPCCode) {
      cpcEntries = Array.isArray(header.CPCCode) ? header.CPCCode : [header.CPCCode];
    }

    let invoiceEntries = [];
    if (header.Invoice) {
      invoiceEntries = Array.isArray(header.Invoice) ? header.Invoice : [header.Invoice];
    }

    let items = [];
    if (header.Item) {
      items = Array.isArray(header.Item) ? header.Item : [header.Item];
    }

    let finalDeclaredValue = declaredValue;
    if (!finalDeclaredValue || finalDeclaredValue === 0) {
      let invoiceSum = 0;
      for (const inv of invoiceEntries) {
        if (inv.InvoiceFreightAndOtherCharges?.Amount) {
          invoiceSum += parseFloat(String(inv.InvoiceFreightAndOtherCharges.Amount));
        }
      }
      if (!isNaN(invoiceSum) && invoiceSum > 0) {
        finalDeclaredValue = invoiceSum;
      }
    }

    let finalTotalPieces = totalPieces;
    if (!finalTotalPieces || finalTotalPieces === 0) {
      finalTotalPieces = items.length;
    }

    if (!hawb || !importerName) {
      throw new Error(`Missing critical fields. HAWB=${hawb}, Importer=${importerName}`);
    }

    if (items.length === 0) {
      throw new Error(`The shipment contains zero <Item> entries.`);
    }

    const transaction = new mssql.Transaction(pool);
    await transaction.begin();

    try {
      // Check for duplicate based on HAWB and jobNo
      const dupCheck = await transaction.request()
        .input('hawb', mssql.VarChar, hawb)
        .input('job_no', mssql.VarChar, jobNo)
        .query('SELECT hawb, job_no FROM shipments_ingested WHERE hawb = @hawb AND job_no = @job_no');
        
      if (dupCheck.recordset.length > 0) {
        throw new Error(`Duplicate record: HAWB=${hawb}, JobNo=${jobNo} already exists.`);
      }

      // Check & insert importer into OutExporter if not already present, then reuse its code
      const exporterCompanyCode = await ensureOutExporterExists(transaction, importerName || '', impExpCrNo || '') || importerName || '';

      // Insert shipment
      await transaction.request()
        .input('hawb', mssql.VarChar, hawb)
        .input('file_id', mssql.VarChar, fileId)
        .input('doc_type', mssql.VarChar, docType)
        .input('doc_version', mssql.VarChar, docVersion)
        .input('sender_org_id', mssql.VarChar, senderOrgId)
        .input('receiver_org_id', mssql.VarChar, receiverOrgId)
        .input('comm_datetime', mssql.VarChar, commDatetime)
        .input('job_no', mssql.VarChar, jobNo)
        .input('job_date', mssql.VarChar, jobDate)
        .input('msg_type', mssql.VarChar, msgType)
        .input('decl_type', mssql.VarChar, declType)
        .input('packing_type', mssql.VarChar, packingType)
        .input('place_of_release', mssql.VarChar, placeOfRelease)
        .input('loc_for_release', mssql.NVarChar, locForRelease)
        .input('place_of_receipt', mssql.VarChar, placeOfReceipt)
        .input('loc_for_receipt', mssql.NVarChar, locForReceipt)
        .input('imp_exp_cr_no', mssql.VarChar, impExpCrNo)
        .input('importer_name', mssql.NVarChar, importerName)
        .input('exp_city_name', mssql.NVarChar, expCityName)
        .input('exp_postal_code', mssql.VarChar, expPostalCode)
        .input('exp_ctry_code', mssql.VarChar, expCtryCode)
        .input('consignee_name', mssql.NVarChar, consigneeName)
        .input('consignee_name2', mssql.NVarChar, consigneeName2)
        .input('consignee_street', mssql.NVarChar, consigneeStreet)
        .input('consignee_post_box', mssql.NVarChar, consigneePostBox)
        .input('consignee_city', mssql.NVarChar, consigneeCity)
        .input('consignee_sub_div_code', mssql.VarChar, consigneeSubDivCode)
        .input('consignee_sub_div_name', mssql.NVarChar, consigneeSubDivName)
        .input('consignee_postal_code', mssql.VarChar, consigneePostalCode)
        .input('consignee_ctry_code', mssql.VarChar, consigneeCtryCode)
        .input('end_user_name', mssql.NVarChar, endUserName)
        .input('end_user_street', mssql.NVarChar, endUserStreet)
        .input('end_user_post_box', mssql.NVarChar, endUserPostBox)
        .input('end_user_city', mssql.NVarChar, endUserCity)
        .input('end_user_sub_div_code', mssql.VarChar, endUserSubDivCode)
        .input('end_user_sub_div_name', mssql.NVarChar, endUserSubDivName)
        .input('end_user_postal_code', mssql.VarChar, endUserPostalCode)
        .input('end_user_ctry_code', mssql.VarChar, endUserCtryCode)
        .input('transport_mode', mssql.VarChar, transportMode)
        .input('ctry_final_dest', mssql.VarChar(100), ctryFinalDest)
        .input('declared_value', mssql.Decimal(18, 2), finalDeclaredValue || 0)
        .input('total_weight', mssql.Decimal(18, 4), totalWeight || 0)
        .input('total_weight_unit', mssql.VarChar, totalWeightUnit)
        .input('total_pieces', mssql.Int, finalTotalPieces || 0)
        .input('total_pieces_unit', mssql.VarChar, totalPiecesUnit)
        .input('remark', mssql.NVarChar(mssql.MAX), remark)
        .query(`
          INSERT INTO shipments_ingested (
            hawb, file_id,
            doc_type, doc_version, sender_org_id, receiver_org_id, comm_datetime,
            job_no, job_date, msg_type, decl_type, packing_type,
            place_of_release, loc_for_release, place_of_receipt, loc_for_receipt,
            imp_exp_cr_no, importer_name, exp_city_name, exp_postal_code, exp_ctry_code,
            consignee_name, consignee_name2, consignee_street, consignee_post_box,
            consignee_city, consignee_sub_div_code, consignee_sub_div_name,
            consignee_postal_code, consignee_ctry_code,
            end_user_name, end_user_street, end_user_post_box,
            end_user_city, end_user_sub_div_code, end_user_sub_div_name,
            end_user_postal_code, end_user_ctry_code,
            transport_mode, ctry_final_dest,
            declared_value, total_weight, total_weight_unit,
            total_pieces, total_pieces_unit, remark
          ) VALUES (
            @hawb, @file_id,
            @doc_type, @doc_version, @sender_org_id, @receiver_org_id, @comm_datetime,
            @job_no, @job_date, @msg_type, @decl_type, @packing_type,
            @place_of_release, @loc_for_release, @place_of_receipt, @loc_for_receipt,
            @imp_exp_cr_no, @importer_name, @exp_city_name, @exp_postal_code, @exp_ctry_code,
            @consignee_name, @consignee_name2, @consignee_street, @consignee_post_box,
            @consignee_city, @consignee_sub_div_code, @consignee_sub_div_name,
            @consignee_postal_code, @consignee_ctry_code,
            @end_user_name, @end_user_street, @end_user_post_box,
            @end_user_city, @end_user_sub_div_code, @end_user_sub_div_name,
            @end_user_postal_code, @end_user_ctry_code,
            @transport_mode, @ctry_final_dest,
            @declared_value, @total_weight, @total_weight_unit,
            @total_pieces, @total_pieces_unit, @remark
          )
        `);

      // Insert OutHeaderTbl
      if (msgType?.toUpperCase() === 'OUTDEC') {
        await transaction.request()
          .input('ref_id', mssql.VarChar, refid)
          .input('jobfer_id', mssql.VarChar, jobferid)
          .input('msg_id', mssql.VarChar, msgid)
          .input('permit_id', mssql.VarChar, permitId)
          .input('mailbox_id', mssql.VarChar, mailboxId)
          .input('msg_type', mssql.VarChar, msgType)
          .input('decl_type', mssql.VarChar, declType)
          .input('packing_type', mssql.VarChar, packingType)
          .input('inward_transport_mode', mssql.VarChar, "--Select--")
          .input('transport_mode', mssql.VarChar, transportMode)
          .input('declarning_for', mssql.VarChar, "--Select--")
          .input('bg_indicator', mssql.VarChar, "--Select--")
          .input('supply_indicator', mssql.VarChar, "false")
          .input('reference_documents', mssql.VarChar, "false")
          .input('license', mssql.VarChar, "----")
          .input('co_type', mssql.VarChar, "--Select--")
          .input('gsp_donor_country', mssql.VarChar, "--Select--")
          .input('cer_detailtype1', mssql.VarChar, "--Select--")
          .input('cer_detailtype2', mssql.VarChar, "--Select--")
          .input('currency_code', mssql.VarChar, "--Select--")
          .input('add_cer_dtl', mssql.VarChar, "----")
          .input('trans_dtl', mssql.VarChar, "----")
          .input('recipient', mssql.VarChar, "--")
          .input('declarant_company_code', mssql.VarChar, declarantCompanyCode)
          .input('exporter_company_code', mssql.VarChar, exporterCompanyCode)
          .input('outward_carrier_agent_code', mssql.VarChar, "")
          .input('freight_forwarder_code', mssql.VarChar, "")
          .input('consignee_name', mssql.NVarChar, consigneeName)
          .input('end_user_name', mssql.NVarChar, endUserName)
          .input('place_of_release', mssql.VarChar, placeOfRelease)
          .input('loc_for_release', mssql.NVarChar, locForRelease)
          .input('place_of_receipt', mssql.VarChar, placeOfReceipt)
          .input('loc_for_receipt', mssql.NVarChar, locForReceipt)
          .input('blanket_start_date', mssql.VarChar, "1900-01-01")
          .input('departure_date', mssql.DateTime, new Date())
          .input('discharge_port', mssql.VarChar, "")
          .input('ctry_final_dest', mssql.VarChar(100), ctryFinalDest)
          .input('vessel_type', mssql.VarChar, "--Select--")
          .input('vessel_nationality', mssql.VarChar, "--Select--")
          .input('out_conveyance_ref_no', mssql.VarChar, "")
          .input('out_transport_id', mssql.VarChar, "")
          .input('out_flight_no', mssql.VarChar, "")
          .input('out_aircraft_reg_no', mssql.VarChar, "")
          .input('out_master_airway_bill', mssql.VarChar, "")
          .input('out_hawb', mssql.VarChar, hawb)
          .input('in_hawb', mssql.VarChar, "")
          .input('total_weight', mssql.Decimal(18, 4), totalWeight || 0)
          .input('total_weight_unit', mssql.VarChar, totalWeightUnit||'--Select--')
          .input('total_pieces', mssql.Int, finalTotalPieces || 0)
          .input('total_pieces_unit', mssql.VarChar, totalPiecesUnit||'--Select--')
          .input('job_no', mssql.VarChar, jobNo)
          .input('remark', mssql.NVarChar(mssql.MAX), remark)
          .query(`insert into OutHeaderTbl (Refid, JobId, MSGId, PermitId, TradeNetMailboxID,MessageType,
                  DeclarationType,CargoPackType,InwardTransportMode,OutwardTransportMode,DeclarningFor,
                  BGIndicator ,SupplyIndicator,ReferenceDocuments,License,COType,GSPDonorCountry,
                  CerDetailtype1,CerDetailtype2,CurrencyCode,AddCerDtl,TransDtl,Recipient,DeclarantCompanyCode,ExporterCompanyCode,
                  OutwardCarrierAgentCode,FreightForwarderCode,CONSIGNEECode,EndUserCode,
                  ReleaseLocation,ResLoaName,RecepitLocation,RecepitLocName,ArrivalDate,
                  BlanketStartDate,DepartureDate,DischargePort,FinalDestinationCountry,VesselType,VesselNationality,
                  OutConveyanceRefNo,OutTransportId,OutFlightNO,OutAircraftRegNo,OutMasterAirwayBill,outHAWB,INHAWB,
                  TotalOuterPack,TotalOuterPackUOM,TotalGrossWeight,TotalGrossWeightUOM,GrossReference,TradeRemarks,
                  InternalRemarks,DeclareIndicator,NumberOfItems,TotalCIFFOBValue,Status,prmtStatus,TouchUser,
                  TouchTime,TotalGSTTaxAmt,TotalExDutyAmt,TotalCusDutyAmt,TotalODutyAmt,TotalAmtPay,Defrentprinting,Cnb) 
                  values (@ref_id, @jobfer_id, @msg_id, @permit_id, @mailbox_id, @msg_type, @decl_type, @packing_type,
                  @inward_transport_mode,@transport_mode, @declarning_for, @bg_indicator, @supply_indicator, 
                  @reference_documents, @license, @co_type, @gsp_donor_country, @cer_detailtype1, @cer_detailtype2, 
                  @currency_code, @add_cer_dtl, @trans_dtl, @recipient, @declarant_company_code,@exporter_company_code,
                  @outward_carrier_agent_code,@freight_forwarder_code,@consignee_name,@end_user_name,@place_of_release,
                  @loc_for_release,@place_of_receipt,@loc_for_receipt,'1900-01-01',@blanket_start_date,@departure_date,@discharge_port,
                  @ctry_final_dest,@vessel_type,@vessel_nationality,@out_conveyance_ref_no,@out_transport_id,@out_flight_no,
                  @out_aircraft_reg_no,@out_master_airway_bill,@out_hawb,@in_hawb,@total_pieces,@total_pieces_unit,@total_weight,
                  @total_weight_unit,@job_no,@remark,'Testing','true','0','0.00','EDR','NEW','Admin',GETDATE(),'0.00','0.00','0.00',
                  '0.00','0.00','false','false')`);   
                  
                  await transaction.request()
          .input('permit_id', mssql.VarChar, permitId)
          .input('msg_type', mssql.VarChar, msgType)
          .input('account_id', mssql.VarChar, accountId)
          .input('msg_id', mssql.VarChar, msgid)
          .input('TouchUser', mssql.VarChar, 'Admin')
          .query(`INSERT INTO PermitCount (PermitId,MessageType, AccountId,MsgId,TouchUser, TouchTime) VALUES (@permit_id, @msg_type, @account_id, @msg_id, @TouchUser, GETDATE())`);
      }

      // Insert CPC codes
      for (const cpc of cpcEntries) {
        const cpcCode = str(cpc.CPCCode);
        const pc = cpc.ProcessingCode || {};
        const processCode1 = str(pc.ProcessCode1);
        const processCode2 = str(pc.ProcessCode2);

        await transaction.request()
          .input('hawb', mssql.VarChar, hawb)
          .input('cpc_code', mssql.VarChar, cpcCode)
          .input('process_code_1', mssql.VarChar, processCode1)
          .input('process_code_2', mssql.VarChar, processCode2)
          .query(`
            INSERT INTO shipment_cpc_codes (hawb, cpc_code, process_code_1, process_code_2)
            VALUES (@hawb, @cpc_code, @process_code_1, @process_code_2)
          `);
          if (msgType?.toUpperCase() === 'OUTDEC') {
            await transaction.request()
            .input('permit_id', mssql.VarChar, permitId)
            .input('cpc_code', mssql.VarChar, cpcCode)
            .input('process_code_1', mssql.VarChar, processCode1)
            .input('process_code_2', mssql.VarChar, processCode2)
            .input('msg_type', mssql.VarChar, msgType)
            .query(`INSERT INTO OutCPCDtl(PermitId,MessageType,RowNo,CPCType,ProcessingCode1,ProcessingCode2,ProcessingCode3,TouchUser,TouchTime)
              VALUES(@permit_id,@msg_type,1,@cpc_code,@process_code_1,@process_code_2,'','KTTSGL02',GETDATE())
            `);
          }
      }

      let ItemInvoiceNo = '';
      let itemCurrencyCode = '';
      // Insert invoices
      for (const inv of invoiceEntries) {
        const invoiceNo = str(inv.InvoiceNo);
        const invoiceDate = str(inv.InvoiceDate);
        const termType = str(inv.TermType);
        const supplierName = str(inv.SupplierName);
        const manuName = str(inv.ManuName);
        const charges = inv.InvoiceFreightAndOtherCharges || {};
        const chargeCode = str(charges.ChargeCode);
        const amount = num(charges.Amount);
        const fromCurrCode = str(charges.FromCurrCode);

        ItemInvoiceNo=str(inv.InvoiceNo)||'--Select--';
        itemCurrencyCode=str(charges.FromCurrCode)||'--Select--';

        await transaction.request()
          .input('hawb', mssql.VarChar, hawb)
          .input('invoice_no', mssql.VarChar, invoiceNo)
          .input('invoice_date', mssql.VarChar, invoiceDate)
          .input('term_type', mssql.VarChar, termType || '--Select--')
          .input('supplier_name', mssql.NVarChar, supplierName)
          .input('manu_name', mssql.NVarChar, manuName)
          .input('charge_code', mssql.VarChar, chargeCode)
          .input('amount', mssql.Decimal(18, 2), amount || 0)
          .input('from_curr_code', mssql.VarChar, fromCurrCode ||'--Select--')
          .query(`
            INSERT INTO shipment_invoices (hawb, invoice_no, invoice_date, term_type, supplier_name, manu_name, charge_code, amount, from_curr_code)
            VALUES (@hawb, @invoice_no, @invoice_date, @term_type, @supplier_name, @manu_name, @charge_code, @amount, @from_curr_code)
          `);

          if (msgType?.toUpperCase() === 'OUTDEC') {
            await transaction.request()
              .input('permit_id', mssql.VarChar, permitId)
              .input('invoice_no', mssql.VarChar, invoiceNo)
              .input('invoice_date', mssql.DateTime, new Date())
              .input('term_type', mssql.VarChar, termType || '--Select--')
              .input('exporter_company_code', mssql.VarChar, exporterCompanyCode)
              .input('amount', mssql.Decimal(18, 2), amount || 0)
              .input('from_curr_code', mssql.VarChar, fromCurrCode ||'--Select--')
              .input('msg_type', mssql.VarChar, msgType)
              .query(`INSERT INTO OutInvoiceDtl(SNo,InvoiceNo,InvoiceDate,TermType,AdValoremIndicator,PreDutyRateIndicator,SupplierImporterRelationship,
                SupplierCode,ExportPartyCode,TICurrency,TIExRate,TIAmount,TISAmount,OTCCharge,OTCCurrency,OTCExRate,OTCAmount,OTCSAmount,FCCharge,
                FCCurrency,FCExRate,FCAmount,FCSAmount,ICCharge,ICCurrency,ICExRate,ICAmount,ICSAmount,CIFSUMAmount,GSTPercentage,GSTSUMAmount,MessageType,PermitId,TouchUser,TouchTime)
                VALUES(1,@invoice_no,@invoice_date,@term_type,'false','false','--Select--','',@exporter_company_code,@from_curr_code,'0.0000',@amount,0,'0.00','--Select--','0.0000','0.00',
                0,'0.00','--Select--','0.0000','0.00',0,'0.00','--Select--','0.0000','0.00',0,'0.00', '9','0.00',@msg_type,@permit_id,'KTTSGL02',GETDATE())
              `);
          }
      }

      // Insert items
      for (let idx = 0; idx < items.length; idx += 1) {
        const item = items[idx];
        const itemSno = idx + 1;
        const hsCode = str(item.ItemHsCode);
        const description = str(item.ItemDesc);
        const countryOrigin = str(item.ItemCtryOrigin);
        const quantity = num(item.ItemQty);
        const itemUnit = str(item.ItemUnit);
        const fobValue = num(item.ItemFOB);
        const itemMark = str(item.ItemMark);
        const itemModel = str(item.ItemModel);
        const itemCatCode = str(item.ItemCatCode);

        const addlInfo = item.ItemAdditionalInfo || {};
        const fobForeignAmt = num(addlInfo.ItemFOBForeignAmt);
        const fobForeignCurr = str(addlInfo.ItemFOBForeignCurr);
        const finalFob = fobValue ?? fobForeignAmt ?? 0;

        await transaction.request()
          .input('hawb', mssql.VarChar, hawb)
          .input('item_sno', mssql.Int, itemSno)
          .input('hs_code', mssql.VarChar, hsCode)
          .input('description', mssql.NVarChar, description)
          .input('country_origin', mssql.VarChar, countryOrigin)
          .input('quantity', mssql.Decimal(18, 4), quantity || 0)
          .input('item_unit', mssql.VarChar, itemUnit)
          .input('fob_value', mssql.Decimal(18, 2), finalFob)
          .input('item_mark', mssql.VarChar, itemMark)
          .input('item_model', mssql.VarChar, itemModel)
          .input('item_cat_code', mssql.VarChar, itemCatCode)
          .input('fob_foreign_amt', mssql.Decimal(18, 2), fobForeignAmt || 0)
          .input('fob_foreign_curr', mssql.VarChar, fobForeignCurr)
          .query(`
            INSERT INTO shipment_items_ingested (
              hawb, item_sno, hs_code, description, country_origin, quantity, item_unit,
              fob_value, item_mark, item_model, item_cat_code,
              fob_foreign_amt, fob_foreign_curr
            ) VALUES (
              @hawb, @item_sno, @hs_code, @description, @country_origin, @quantity, @item_unit,
              @fob_value, @item_mark, @item_model, @item_cat_code,
              @fob_foreign_amt, @fob_foreign_curr
            )
          `);

          if (msgType?.toUpperCase() === 'OUTDEC') {
            await transaction.request()
              .input('permit_id', mssql.VarChar, permitId)
              .input('item_sno', mssql.Int, itemSno)
              .input('msg_type', mssql.VarChar, msgType)
              .input('hs_code', mssql.VarChar, hsCode)
              .input('description', mssql.NVarChar, description)
              .input('dg_indicator', mssql.VarChar, "false")
              .input('country_origin', mssql.VarChar, countryOrigin)
              .input('end_user_description', mssql.NVarChar, "")
              .input('brand', mssql.VarChar, "")
              .input('model', mssql.VarChar, itemModel)
              .input('in_hawb_obl', mssql.VarChar, "")
              .input('out_hawb_obl', mssql.VarChar, hawb)
              .input('dutiable_qty', mssql.Decimal(18, 4), 0)
              .input('dutiable_uom', mssql.VarChar, "--Select--")
              .input('total_dutiable_qty', mssql.Decimal(18, 4), 0)
              .input('total_dutiable_uom', mssql.VarChar, "--Select--")
              .input('invoice_quantity', mssql.Decimal(18, 4), quantity || 0)
              .input('hs_qty', mssql.Decimal(18, 4), quantity || 0)
              .input('hs_uom', mssql.VarChar, itemUnit)
              .input('alcohol_per', mssql.Decimal(5, 2), 0)
              .input('invoice_no', mssql.VarChar, ItemInvoiceNo || '--Select--')
              .input('chk_unit_price', mssql.VarChar, "false")
              .input('unit_price', mssql.Decimal(18, 4),  0)
              .input('unit_price_currency', mssql.VarChar, itemCurrencyCode || '--Select--')
              .input('exchange_rate', mssql.Decimal(18, 6), 0)
              .input('sum_exchange_rate', mssql.Decimal(18, 6), 0)
              .input('total_line_amount', mssql.Decimal(18, 2), finalFob)
              .input('invoice_charges', mssql.Decimal(18, 2), 0)
              .input('ciffob', mssql.Decimal(18, 2), 0)
              .input('op_qty', mssql.Decimal(18, 4), 0)
              .input('op_uom', mssql.VarChar, "--Select--")
              .input('ip_qty', mssql.Decimal(18, 4), 0)
              .input('ip_uom', mssql.VarChar, "--Select--")
              .input('in_pqty', mssql.Decimal(18, 4), 0)
              .input('in_puom', mssql.VarChar, "--Select--")
              .input('im_pqty', mssql.Decimal(18, 4), 0)
              .input('im_puom', mssql.VarChar, "--Select--")
              .input('preferential_code', mssql.VarChar, "--Select--")
              .input('gst_rate', mssql.Decimal(5, 2), 9)
              .input('gst_uom', mssql.VarChar, "PER")
              .input('gst_amount', mssql.Decimal(18, 2), 0)
              .input('excise_duty_rate', mssql.Decimal(5, 2), 0)
              .input('excise_duty_uom', mssql.VarChar, "--Select-- ")
              .input('excise_duty_amount', mssql.Decimal(18, 2), 0)
              .input('customs_duty_rate', mssql.Decimal(5, 2), 0)
              .input('customs_duty_uom', mssql.VarChar, "--Select--")
              .input('customs_duty_amount', mssql.Decimal(18, 2), 0)
              .input('other_tax_rate', mssql.Decimal(5, 2), 0)
              .input('other_tax_uom', mssql.VarChar, "--Select--")
              .input('other_tax_amount', mssql.Decimal(18, 2), 0)
              .input('current_lot', mssql.VarChar, "")
              .input('previous_lot', mssql.VarChar, "")
              .input('making', mssql.VarChar, "--Select--")
              .input('shipping_marks1', mssql.VarChar, "")
              .input('shipping_marks2', mssql.VarChar, "")
              .input('shipping_marks3', mssql.VarChar, "")
              .input('shipping_marks4', mssql.VarChar, "")
              .input('cer_item_qty', mssql.Decimal(18, 4), 0)
              .input('cer_item_uom', mssql.VarChar, "--Select--")
              .input('cif_val_of_cer', mssql.Decimal(18, 2), 0)
              .input('manufacture_cost_date', mssql.VarChar, "1900-01-01")
              .input('tex_cat', mssql.VarChar, "")
              .input('tex_quota_qty', mssql.Decimal(18, 4), 0)
              .input('tex_quota_uom', mssql.VarChar, "--Select--")
              .input('cer_inv_no', mssql.VarChar, "")
              .input('cer_inv_date', mssql.VarChar, "1900-01-01")
              .input('origin_of_cer', mssql.VarChar, ",,,")
              .input('hs_code_cer', mssql.VarChar, "")
              .input('per_content', mssql.VarChar, "")
              .input('certificate_description', mssql.VarChar, "")
              .input('touch_user', mssql.VarChar, 'KTTSGL02')
              .input('touch_time', mssql.DateTime, new Date())   
              .input('vehicle_type', mssql.VarChar, "--Select--")        
              .input('optional_chrge_uom', mssql.VarChar, "--Select--")
              .input('engine_capcity', mssql.VarChar, "")   
              .input('optioncahrge', mssql.Decimal(18, 2), 0)
              .input('optional_sumtotal', mssql.Decimal(18, 2), 0)
              .input('optional_sumexchage', mssql.Decimal(18, 6), 0)
              .input('engine_capuom', mssql.VarChar, "--Select--")
              .input('orignaldatereg', mssql.VarChar, "1900-01-01")
              .query(`INSERT INTO OutItemDtl(ItemNo,PermitId,MessageType,HSCode,Description,DGIndicator,Contry,EndUserDescription,Brand
                      ,Model,InHAWBOBL,OutHAWBOBL,DutiableQty,DutiableUOM,TotalDutiableQty,TotalDutiableUOM,InvoiceQuantity,HSQty,HSUOM
                      ,AlcoholPer,InvoiceNo,ChkUnitPrice,UnitPrice,UnitPriceCurrency,ExchangeRate,SumExchangeRate,TotalLineAmount,InvoiceCharges
                      ,CIFFOB,OPQty,OPUOM,IPQty,IPUOM,InPqty,InPUOM,ImPQty,ImPUOM,PreferentialCode,GSTRate,GSTUOM,GSTAmount,ExciseDutyRate,ExciseDutyUOM
                      ,ExciseDutyAmount,CustomsDutyRate,CustomsDutyUOM,CustomsDutyAmount,OtherTaxRate,OtherTaxUOM,OtherTaxAmount,CurrentLot,PreviousLot,Making
                      ,ShippingMarks1,ShippingMarks2,ShippingMarks3,ShippingMarks4,CerItemQty,CerItemUOM,CIFValOfCer,ManufactureCostDate,TexCat,TexQuotaQty,TexQuotaUOM
                      ,CerInvNo,CerInvDate,OriginOfCer,HSCodeCer,PerContent,CertificateDescription,TouchUser,TouchTime,VehicleType,OptionalChrgeUOM,EngineCapcity
                      ,Optioncahrge,OptionalSumtotal,OptionalSumExchage,EngineCapUOM,orignaldatereg) 
                      values(@item_sno,@permit_id,@msg_type,@hs_code,@description,@dg_indicator,@country_origin,@end_user_description,@brand
                      ,@model,@in_hawb_obl,@out_hawb_obl,@dutiable_qty,@dutiable_uom,@total_dutiable_qty,@total_dutiable_uom,@invoice_quantity,@hs_qty,@hs_uom
                      ,@alcohol_per,@invoice_no,@chk_unit_price,@unit_price,@unit_price_currency,@exchange_rate,@sum_exchange_rate,@total_line_amount,@invoice_charges
                      ,@ciffob,@op_qty,@op_uom,@ip_qty,@ip_uom,@in_pqty,@in_puom,@im_pqty,@im_puom,@preferential_code,@gst_rate,@gst_uom,@gst_amount,@excise_duty_rate,@excise_duty_uom
                      ,@excise_duty_amount,@customs_duty_rate,@customs_duty_uom,@customs_duty_amount,@other_tax_rate,@other_tax_uom,@other_tax_amount,@current_lot,@previous_lot,@making
                      ,@shipping_marks1,@shipping_marks2,@shipping_marks3,@shipping_marks4,@cer_item_qty,@cer_item_uom,@cif_val_of_cer,@manufacture_cost_date,@tex_cat,@tex_quota_qty,@tex_quota_uom
                      ,@cer_inv_no,@cer_inv_date,@origin_of_cer,@hs_code_cer,@per_content,@certificate_description,@touch_user,@touch_time,@vehicle_type,@optional_chrge_uom,@engine_capcity
                      ,@optioncahrge,@optional_sumtotal,@optional_sumexchage,@engine_capuom,@orignaldatereg)` )
          }
      }

      await transaction.commit();

      await dbRun(
        'UPDATE edi_file_logs SET status = ?, record_count = ?, updated_at = GETDATE() WHERE file_id = ?',
        ['Success', items.length, fileId]
      );

      archiveFile(filePath, log.user_id, log.original_filename);

      console.log(`✅ Ingested ALL tags for HAWB=${hawb}: ${items.length} items, ${cpcEntries.length} CPC codes, ${invoiceEntries.length} invoices`);
      return { success: true };

    } catch (txError: any) {
      try {
        await transaction.rollback();
      } catch (rollbackErr) {
        console.error('Error rolling back transaction:', rollbackErr);
      }
      throw txError;
    }

  } catch (error: any) {
    console.error(`Error processing Customs file ${fileId}:`, error.message);
    
    await dbRun(
      'UPDATE edi_file_logs SET status = ?, error_message = ?, updated_at = GETDATE() WHERE file_id = ?',
      ['Failed', error.message || 'Unknown processing error', fileId]
    );

    const log = await dbGet<{ user_id: string; original_filename: string; stored_path: string }>(
      'SELECT user_id, original_filename, stored_path FROM edi_file_logs WHERE file_id = ?',
      [fileId]
    );

    if (log) {
      archiveFailedFile(log.stored_path, log.user_id, log.original_filename);
    }

    return { success: false, error: error.message };
  }
};

const archiveFile = (filePath: string, userId: string, originalFilename: string) => {
  try {
    const archiveDir = archiveFolderPath(userId);
    if (!fs.existsSync(archiveDir)) {
      fs.mkdirSync(archiveDir, { recursive: true });
    }
    const destPath = path.join(archiveDir, `${Date.now()}_${originalFilename}`);
    fs.renameSync(filePath, destPath);
    console.log(`Archived: ${destPath}`);
  } catch (err: any) {
    console.error('Failed to archive file:', err.message);
  }
};

const archiveFailedFile = (filePath: string, userId: string, originalFilename: string) => {
  try {
    const errorDir = errorFolderPath(userId);
    if (!fs.existsSync(errorDir)) {
      fs.mkdirSync(errorDir, { recursive: true });
    }
    const destPath = path.join(errorDir, `${Date.now()}_failed_${originalFilename}`);
    fs.renameSync(filePath, destPath);
    console.log(`Failed file archived: ${destPath}`);
  } catch (err: any) {
    console.error('Failed to archive error file:', err.message);
  }
};
