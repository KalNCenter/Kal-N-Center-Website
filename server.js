import 'dotenv/config'
import express from 'express'
import session from 'express-session'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import QRCode from 'qrcode'
import pg from 'pg'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'

const { Pool } = pg

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
})

const query = (text, params = []) => pool.query(text, params)

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()
const PORT = process.env.PORT || 5173
const UPLOAD_ROOT = path.join(__dirname, 'uploads')
const REPORTS_DIR = path.join(UPLOAD_ROOT, 'reports')

fs.mkdirSync(UPLOAD_ROOT, { recursive: true })
fs.mkdirSync(REPORTS_DIR, { recursive: true })
fs.mkdirSync(path.join(UPLOAD_ROOT, 'cards'), { recursive: true })
fs.mkdirSync(path.join(UPLOAD_ROOT, 'banners'), { recursive: true })

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
const makeId = (prefix = 'id') => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 100000)}`

const getBaseUrl = (req) =>
  (process.env.BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '')

const getCurrentUser = async (req) => {
  if (!req.session.userEmail) return null

  const result = await query(
    `SELECT * FROM users WHERE LOWER(email) = $1 LIMIT 1`,
    [req.session.userEmail.toLowerCase()]
  )

  return result.rows[0] || null
}

const sharedViewData = async (req, extra = {}) => {
  const user = await getCurrentUser(req)

  return {
    siteName: "Kal'N Center",
    currentUser: user,
    isAdmin: user?.role === 'admin',
    navLabels: {
      home: 'Home',
      myReports: 'My Reports',
      cardReports: 'Card Reports',
      merchandise: 'Merchandise',
      admin: 'Admin',
    },
    flash: '',
    ...extra,
  }
}

const requireLogin = (req, res, next) => {
  if (!req.session.userEmail) return res.redirect('/login')
  next()
}

const requireAdmin = async (req, res, next) => {
  const user = await getCurrentUser(req)
  if (!user || user.role !== 'admin') return res.redirect('/login')
  next()
}

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
const uploadStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, REPORTS_DIR)
  },
  filename: (req, file, cb) => {
    const reportNumber = String(req.body.report_number || 'report').replace(/[^a-zA-Z0-9_-]/g, '_')
    const ext = path.extname(file.originalname) || (file.fieldname === 'html_file' ? '.html' : '.pdf')
    cb(null, `${reportNumber}-${file.fieldname}${ext}`)
  },
})

const reportUpload = multer({ storage: uploadStorage })
app.get('/', async (req, res) => {
  const banners = [
    'https://images.unsplash.com/photo-1511512578047-dfb367046420?auto=format&fit=crop&w=1600&q=80',
    'https://images.unsplash.com/photo-1518131678677-a55b72d10f5e?auto=format&fit=crop&w=1600&q=80',
    'https://images.unsplash.com/photo-1608889175123-8ee362201f81?auto=format&fit=crop&w=1600&q=80',
    'https://images.unsplash.com/photo-1627856013091-fed6e4e30025?auto=format&fit=crop&w=1600&q=80',
  ]

  const content = {
    heroTitle: 'Professional card reports, collector access, and future trading tools.',
    heroSubtitle:
      'Explore graded card reports, manage your personal collection, and test QR-linked report pages locally before going live.',
    companyHeading: "Kal'N-Center Website",
    companyIntro:
      "Kal'N-Center is not a replacement for PSA, CGC, Tag or other well known Trading Card Companies. Currently our focus is Pokémon Card. The services we provide are: Pre-grading, Authentication likeliness, Card Preservation, Reporting, and cataloging.",
    companyIntro2:
      "All of these services give information when buying and selling raw cards. For collectors who don't want to send a card out for grading, this is a great option to improve your display case and preserve your collection, and digitalize it with detailed reports.",
    serviceHeading: "About the Kal'N-Center services",
    preGrading:
      'Our system sticks to the four basics of visual inspections: centering, corners, edges, and surface.',
    authentication:
      'It is not possible for our systems to perform the rip test on every card. The card images are compared to a database of same or similar cards to check reference points, measurements, and key features. With that information, we then provide a percentage of likeliness.',
    reporting:
      "Each time a card is graded a report is generated. The report includes the total grade, subgrades, enlarged images of the card, and a printable Kal'N-Center slab tag. The reports are stored on the local test website, and the QR code on the slab tag is a shortcut directly to the report page.",
    preservation:
      'Bring in your favorite card to put into a slab to display with honor, or just to help protect your investment.',
    contactHeading: 'Contact Us',
    contactText:
      'Provide your email and any message or question you have, and we will get back to you ASAP!',
  }

  res.render('home', await sharedViewData(req, { title: 'Home', banners, content }))
})

app.get('/login', async (req, res) => {
  res.render('login', await sharedViewData(req, { title: 'Log In' }))
})

app.post('/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase()
  const password = String(req.body.password || '')

  const result = await query(
    `SELECT * FROM users WHERE LOWER(email) = $1 AND password = $2 LIMIT 1`,
    [email, password]
  )

  const user = result.rows[0]

  if (!user) {
    return res.redirect('/login')
  }

  req.session.userEmail = user.email
  res.redirect(user.role === 'admin' ? '/admin' : '/my-reports')
})

app.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/')
  })
})

app.get('/signup', async (req, res) => {
  res.render('signup', await sharedViewData(req, { title: 'New Account' }))
})

app.post('/signup', async (req, res) => {
  const { email, username, firstName, lastName, password, confirmPassword } = req.body

  if (password !== confirmPassword) {
    return res.redirect('/signup')
  }

  const existing = await query(
    `SELECT 1 FROM users WHERE LOWER(email) = $1 LIMIT 1`,
    [String(email).trim().toLowerCase()]
  )

  if (existing.rows.length) {
    return res.redirect('/signup')
  }

  await query(
    `INSERT INTO users (id, email, username, first_name, last_name, password, role, trade_enabled)
     VALUES ($1, $2, $3, $4, $5, $6, 'user', FALSE)`,
    [
      makeId('user'),
      String(email).trim(),
      String(username || '').trim(),
      String(firstName || '').trim(),
      String(lastName || '').trim(),
      String(password),
    ]
  )

  req.session.userEmail = String(email).trim()
  res.redirect('/my-reports')
})

app.get('/my-reports', requireLogin, async (req, res) => {
  const user = await getCurrentUser(req)

  const result = await query(
    'SELECT * FROM reports WHERE LOWER(registered_user) = $1 ORDER BY created_at DESC',
    [user.email.toLowerCase()]
  )

  const reports = result.rows.map((report) => ({
    ...report,
    reportNumber: report.report_number,
    cardName: report.card_name,
    cardNumber: report.card_number,
    cardGrade: report.card_grade,
    setName: report.set_name,
    reportDate: report.report_date,
    registeredUser: report.registered_user,
    cardImage: report.card_image,
  }))

  res.render('my-reports', {
    ...(await sharedViewData(req)),
    title: 'My Reports',
    reports,
    userRecord: user,
  })
})

app.post('/my-reports/toggle-trades', requireLogin, async (req, res) => {
  const user = await getCurrentUser(req)

  await query(
    `UPDATE users SET trade_enabled = NOT COALESCE(trade_enabled, FALSE) WHERE LOWER(email) = $1`,
    [user.email.toLowerCase()]
  )

  res.redirect('/my-reports')
})

app.post('/my-reports/:id/tradable', requireLogin, async (req, res) => {
  const user = await getCurrentUser(req)

  await query(
    `UPDATE reports
     SET tradable = $1
     WHERE id = $2 AND LOWER(registered_user) = $3`,
    [req.body.tradable === 'on', req.params.id, user.email.toLowerCase()]
  )

  res.redirect('/my-reports')
})

app.get('/card-reports', async (req, res) => {
  const result = await query('SELECT * FROM reports ORDER BY created_at DESC')

  const reports = result.rows.map((report) => ({
    ...report,
    reportNumber: report.report_number,
    cardName: report.card_name,
    cardNumber: report.card_number,
    cardGrade: report.card_grade,
    setName: report.set_name,
    reportDate: report.report_date,
    registeredUser: report.registered_user,
    cardImage: report.card_image,
  }))

  res.render('card-reports', {
    ...(await sharedViewData(req)),
    title: 'Card Reports',
    reports,
  })
})

app.get('/report/:id', async (req, res) => {
  const result = await query(
    `SELECT * FROM reports WHERE id = $1 OR report_number = $1 LIMIT 1`,
    [req.params.id]
  )

  const row = result.rows[0]

  if (!row) {
    return res.status(404).render(
      'message',
      await sharedViewData(req, {
        title: 'Not Found',
        heading: 'Report not found',
        body: 'The requested report could not be found.',
      })
    )
  }

  const report = {
    ...row,
    reportNumber: row.report_number,
    cardName: row.card_name,
    cardNumber: row.card_number,
    cardGrade: row.card_grade,
    setName: row.set_name,
    reportDate: row.report_date,
    registeredUser: row.registered_user,
    cardImage: row.card_image,
    reportFile: row.report_file,
    subgrades: {
      centering: row.centering,
      corners: row.corners,
      edges: row.edges,
      surface: row.surface,
    },
  }

  const reportUrl = `${getBaseUrl(req)}/report/${report.id}`
  const qr = await QRCode.toDataURL(reportUrl)

  res.render(
    'report-detail',
    await sharedViewData(req, {
      title: report.reportNumber,
      report,
      qrDataUrl: qr,
      reportUrl,
    })
  )
})

app.get('/merchandise', async (req, res) => {
  res.render('merchandise', await sharedViewData(req, { title: 'Merchandise' }))
})

app.post('/contact', async (req, res) => {
  await query(
    `INSERT INTO contacts (id, email, message, created_at)
     VALUES ($1, $2, $3, NOW())`,
    [makeId('contact'), String(req.body.email || '').trim(), String(req.body.message || '').trim()]
  )

  res.redirect('/')
})

app.get('/admin', requireAdmin, async (req, res) => {
  const reportsResult = await query(`SELECT * FROM reports ORDER BY id DESC`)
  const contactsResult = await query(`SELECT * FROM contacts ORDER BY created_at DESC`)

  const db = {
    config: {
      navLabels: {
        home: 'Home',
        myReports: 'My Reports',
        cardReports: 'Card Reports',
        merchandise: 'Merchandise',
        admin: 'Admin',
      },
      banners: [
        'https://images.unsplash.com/photo-1511512578047-dfb367046420?auto=format&fit=crop&w=1600&q=80',
        'https://images.unsplash.com/photo-1518131678677-a55b72d10f5e?auto=format&fit=crop&w=1600&q=80',
        'https://images.unsplash.com/photo-1608889175123-8ee362201f81?auto=format&fit=crop&w=1600&q=80',
        'https://images.unsplash.com/photo-1627856013091-fed6e4e30025?auto=format&fit=crop&w=1600&q=80',
      ],
      content: {
        heroTitle: 'Professional card reports, collector access, and future trading tools.',
        heroSubtitle:
          'Explore graded card reports, manage your personal collection, and test QR-linked report pages locally before going live.',
        companyHeading: "Kal'N-Center Website",
        companyIntro:
          "Kal'N-Center is not a replacement for PSA, CGC, Tag or other well known Trading Card Companies. Currently our focus is Pokémon Card. The services we provide are: Pre-grading, Authentication likeliness, Card Preservation, Reporting, and cataloging.",
        companyIntro2:
          "All of these services give information when buying and selling raw cards. For collectors who don't want to send a card out for grading, this is a great option to improve your display case and preserve your collection, and digitalize it with detailed reports.",
        serviceHeading: "About the Kal'N-Center services",
        preGrading:
          'Our system sticks to the four basics of visual inspections: centering, corners, edges, and surface.',
        authentication:
          'It is not possible for our systems to perform the rip test on every card. The card images are compared to a database of same or similar cards to check reference points, measurements, and key features. With that information, we then provide a percentage of likeliness.',
        reporting:
          "Each time a card is graded a report is generated. The report includes the total grade, subgrades, enlarged images of the card, and a printable Kal'N-Center slab tag. The reports are stored on the local test website, and the QR code on the slab tag is a shortcut directly to the report page.",
        preservation:
          'Bring in your favorite card to put into a slab to display with honor, or just to help protect your investment.',
        contactHeading: 'Contact Us',
        contactText:
          'Provide your email and any message or question you have, and we will get back to you ASAP!',
      },
    },
    reports: reportsResult.rows,
    contacts: contactsResult.rows,
  }

  res.render('admin', await sharedViewData(req, { title: 'Admin', db }))
})

app.post(
  '/admin/content',
  requireAdmin,
  upload.fields([
    { name: 'bannerFile0', maxCount: 1 },
    { name: 'bannerFile1', maxCount: 1 },
    { name: 'bannerFile2', maxCount: 1 },
    { name: 'bannerFile3', maxCount: 1 },
  ]),
  async (req, res) => {
    res.redirect('/admin')
  }
)

app.post(
  '/admin/report-upload',
  requireAdmin,
  upload.fields([
    { name: 'cardImageFile', maxCount: 1 },
    { name: 'reportFile', maxCount: 1 },
  ]),
  async (req, res) => {
    const cardImage = req.files?.cardImageFile?.[0]
    const reportFile = req.files?.reportFile?.[0]

    await query(
      `INSERT INTO reports (
        id, report_number, card_name, card_number, card_grade, set_name,
        report_date, registered_user, tradable, card_image, report_file,
        notes, centering, corners, edges, surface
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16
      )`,
      [
        makeId('rpt'),
        String(req.body.reportNumber || '').trim(),
        String(req.body.cardName || '').trim(),
        String(req.body.cardNumber || '').trim(),
        String(req.body.cardGrade || '').trim(),
        String(req.body.setName || '').trim(),
        String(req.body.reportDate || '').trim() || null,
        String(req.body.registeredUser || '').trim(),
        req.body.tradable === 'on',
        cardImage ? `/uploads/cards/${cardImage.filename}` : String(req.body.cardImageUrl || '').trim(),
        reportFile ? `/uploads/reports/${reportFile.filename}` : '',
        String(req.body.notes || '').trim(),
        String(req.body.centering || '').trim(),
        String(req.body.corners || '').trim(),
        String(req.body.edges || '').trim(),
        String(req.body.surface || '').trim(),
      ]
    )

    res.redirect('/admin')
  }
)
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
        return res.status(400).json({ error: 'Missing html_file or pdf_file' })
      }

const htmlBuffer = fs.readFileSync(htmlFile.path)
const pdfBuffer = fs.readFileSync(pdfFile.path)

const htmlKey = `reports/${reportNumber}/index.html`
const pdfKey = `reports/${reportNumber}/report.pdf`

await s3.send(
  new PutObjectCommand({
    Bucket: process.env.S3_BUCKET,
    Key: htmlKey,
    Body: htmlBuffer,
    ContentType: 'text/html',
  })
)

await s3.send(
  new PutObjectCommand({
    Bucket: process.env.S3_BUCKET,
    Key: pdfKey,
    Body: pdfBuffer,
    ContentType: 'application/pdf',
  })
)

const htmlUrl = `https://${process.env.S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${htmlKey}`
const pdfUrl = `https://${process.env.S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${pdfKey}`

      return res.json({
        success: true,
        report_url: htmlUrl,
        pdf_url: pdfUrl
      })
    } catch (err) {
      console.error('Upload error:', err)
      return res.status(500).json({ error: 'Upload failed' })
    }
  }
)

app.post('/api/upload-report', async (req, res) => {
  try {
    const {
      reportNumber,
      cardName,
      cardNumber,
      cardGrade,
      setName,
      reportDate,
      registeredUser,
      tradable,
      cardImage,
      reportFile,
      notes,
      centering,
      corners,
      edges,
      surface
    } = req.body

    await query(`
      INSERT INTO reports (
        id,
        report_number,
        card_name,
        card_number,
        card_grade,
        set_name,
        report_date,
        registered_user,
        tradable,
        card_image,
        report_file,
        notes,
        centering,
        corners,
        edges,
        surface
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16
      )
    `, [
      `report-${Date.now()}`,
      reportNumber,
      cardName,
      cardNumber,
      cardGrade,
      setName,
      reportDate,
      registeredUser,
      tradable,
      cardImage,
      reportFile,
      notes,
      centering,
      corners,
      edges,
      surface
    ])

    res.json({ success: true })

  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Upload failed' })
  }
})
app.listen(PORT, () => {
  console.log(`RUNNING ON http://localhost:${PORT}`)
})
