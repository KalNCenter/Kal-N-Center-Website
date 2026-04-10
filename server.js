import 'dotenv/config'
import express from 'express'
import session from 'express-session'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import QRCode from 'qrcode'
import pg from 'pg'

const { Pool } = pg

// =======================
// 🔧 PATH SETUP (FIXED)
// =======================
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const UPLOAD_ROOT = path.join(__dirname, 'uploads')
const REPORTS_DIR = path.join(UPLOAD_ROOT, 'reports')

// CREATE FOLDERS
fs.mkdirSync(UPLOAD_ROOT, { recursive: true })
fs.mkdirSync(REPORTS_DIR, { recursive: true })
fs.mkdirSync(path.join(UPLOAD_ROOT, 'cards'), { recursive: true })
fs.mkdirSync(path.join(UPLOAD_ROOT, 'banners'), { recursive: true })

// =======================
// 🔧 DATABASE
// =======================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
})
const query = (text, params = []) => pool.query(text, params)

// =======================
// 🔧 APP SETUP
// =======================
const app = express()
const PORT = process.env.PORT || 5173

app.set('view engine', 'ejs')
app.set('views', path.join(__dirname, 'views'))

app.use(express.urlencoded({ extended: true }))
app.use(express.json())

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'supersecret123',
    resave: false,
    saveUninitialized: false,
  })
)

app.use(express.static(path.join(__dirname, 'public')))
app.use('/uploads', express.static(UPLOAD_ROOT))

app.use((req, res, next) => {
  res.locals.currentPath = req.path
  next()
})

// =======================
// 🔧 HELPERS
// =======================
const makeId = (prefix = 'id') =>
  `${prefix}-${Date.now()}-${Math.floor(Math.random() * 100000)}`

const getBaseUrl = (req) =>
  (process.env.BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '')

// =======================
// 🔧 MULTER (ADMIN)
// =======================
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    let folder = 'reports'
    if (file.fieldname.includes('banner')) folder = 'banners'
    if (file.fieldname === 'cardImageFile') folder = 'cards'

    const target = path.join(UPLOAD_ROOT, folder)
    fs.mkdirSync(target, { recursive: true })
    cb(null, target)
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`)
  },
})

const upload = multer({ storage })

// =======================
// 🔧 MULTER (APP UPLOAD)
// =======================
const uploadStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, REPORTS_DIR)
  },
  filename: (req, file, cb) => {
    const reportNumber = String(req.body.report_number || 'report').replace(/[^a-zA-Z0-9_-]/g, '_')
    const ext = path.extname(file.originalname) || (file.fieldname === 'html_file' ? '.html' : '.pdf')
    cb(null, `${reportNumber}-${file.fieldname}${ext}`)
  }
})

const reportUpload = multer({ storage: uploadStorage })

// =======================
// 🏠 HOME
// =======================
app.get('/', async (req, res) => {
  res.render('home', { title: 'Home' })
})

// =======================
// 📊 CARD REPORTS (FIXED)
// =======================
app.get('/card-reports', async (req, res) => {
  const result = await query('SELECT * FROM reports ORDER BY created_at DESC')

  const reports = result.rows.map(r => ({
    ...r,
    reportNumber: r.report_number,
    cardName: r.card_name,
    cardNumber: r.card_number,
    cardGrade: r.card_grade,
    setName: r.set_name,
    reportDate: r.report_date,
    registeredUser: r.registered_user,
    cardImage: r.card_image,
  }))

  res.render('card-reports', {
    title: 'Card Reports',
    reports,
  })
})

// =======================
// 📄 REPORT DETAIL
// =======================
app.get('/report/:id', async (req, res) => {
  const result = await query(
    `SELECT * FROM reports WHERE id = $1 OR report_number = $1 LIMIT 1`,
    [req.params.id]
  )

  const row = result.rows[0]
  if (!row) return res.status(404).send('Report not found')

  const reportUrl = `${getBaseUrl(req)}/report/${row.id}`
  const qr = await QRCode.toDataURL(reportUrl)

  res.render('report-detail', {
    report: row,
    qrDataUrl: qr,
    reportUrl,
  })
})

// =======================
// 🚀 DESKTOP APP UPLOAD (NEW)
// =======================
app.post(
  '/upload',
  reportUpload.fields([
    { name: 'html_file', maxCount: 1 },
    { name: 'pdf_file', maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const reportNumber = String(req.body.report_number || '').trim()

      if (!reportNumber) {
        return res.status(400).json({ error: 'Missing report_number' })
      }

      const htmlFile = req.files?.html_file?.[0]
      const pdfFile = req.files?.pdf_file?.[0]

      if (!htmlFile || !pdfFile) {
        return res.status(400).json({ error: 'Missing files' })
      }

      const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`

      const reportUrl = `${baseUrl}/uploads/reports/${htmlFile.filename}`
      const pdfUrl = `${baseUrl}/uploads/reports/${pdfFile.filename}`

      console.log("UPLOAD SUCCESS:", reportNumber)

      res.json({
        success: true,
        report_url: reportUrl,
        pdf_url: pdfUrl,
      })

    } catch (err) {
      console.error("UPLOAD ERROR:", err)
      res.status(500).json({ error: 'Upload failed' })
    }
  }
)

// =======================
// 🚀 START SERVER
// =======================
app.listen(PORT, () => {
  console.log(`RUNNING ON http://localhost:${PORT}`)
})