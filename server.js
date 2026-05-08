import express from 'express';
import nodemailer from 'nodemailer';
import cors from 'cors';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import Razorpay from 'razorpay';
import crypto from 'crypto';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { fileURLToPath } from 'url';

// Resolve __dirname for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from backend/ directory (not cwd)
dotenv.config({ path: path.join(__dirname, '.env') });

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Ensure uploads directory exists inside backend/
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}

// Serve uploaded files statically
app.use('/uploads', express.static(uploadDir));

// --- Multer Setup for File Uploads ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({ storage: storage });

// --- MongoDB Setup ---
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/sherlocks_life';
mongoose.connect(MONGODB_URI)
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch(err => console.error('❌ MongoDB connection error:', err));

// --- Database Schemas ---
const subsidySchema = new mongoose.Schema({
  t_name: String,
  t_phone: String,
  t_social: String,
  u_name: String,
  u_phone: String,
  u_email: String,
  category: String,
  roles: [String],
  relation: String,
  state: String,
  idProofUrls: [String], // Array of file paths
  paymentStatus: { type: String, default: 'pending' },
  razorpayOrderId: String,
  razorpayPaymentId: String,
  amount: { type: Number, default: 4200 },
  createdAt: { type: Date, default: Date.now }
});

const contactSchema = new mongoose.Schema({
  name: String,
  email: String,
  message: String,
  createdAt: { type: Date, default: Date.now }
});

const SubsidyForm = mongoose.model('SubsidyForm', subsidySchema);
const Contact = mongoose.model('Contact', contactSchema);

// --- Razorpay Setup ---
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || 'rzp_test_placeholder',
  key_secret: process.env.RAZORPAY_KEY_SECRET || 'secret_placeholder',
});

// --- Email Setup ---
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER || 'akhilthadaka97@gmail.com',
    pass: process.env.EMAIL_PASS || 'tvmfcgnqqdyofduh',
  },
});

// --- API Routes ---

app.get('/', (req, res) => {
  res.send('✅ Sherlock\'s Life Backend is Running!');
});

// 1. Create Subsidy Registration (Initial)
// We use upload.array('idCards') to accept multiple files
app.post('/api/subsidy/register', upload.array('idCards'), async (req, res) => {
  try {
    const filePaths = req.files ? req.files.map(file => `/uploads/${file.filename}`) : [];
    
    // Multer puts form fields in req.body
    const subsidyData = new SubsidyForm({
      ...req.body,
      roles: JSON.parse(req.body.roles || '[]'), // Roles come as a stringified array in FormData
      idProofUrls: filePaths
    });

    const savedForm = await subsidyData.save();
    res.status(201).json({ success: true, formId: savedForm._id });
  } catch (error) {
    console.error('Error saving subsidy form:', error);
    res.status(500).json({ success: false, message: 'Failed to register subsidy form' });
  }
});

app.post('/api/payment/create-order', async (req, res) => {
  try {
    const { amount, currency = 'INR' } = req.body;
    const options = {
      amount: amount * 100,
      currency,
      receipt: `receipt_${Date.now()}`,
    };

    const order = await razorpay.orders.create(options);
    res.status(200).json({ success: true, order });
  } catch (error) {
    console.error('Error creating Razorpay order:', error);
    res.status(500).json({ success: false, message: 'Failed to create payment order' });
  }
});

app.post('/api/payment/verify', async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, formId } = req.body;

    const body = razorpay_order_id + "|" + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || 'secret_placeholder')
      .update(body.toString())
      .digest('hex');

    if (expectedSignature === razorpay_signature) {
      await SubsidyForm.findByIdAndUpdate(formId, {
        paymentStatus: 'completed',
        razorpayOrderId: razorpay_order_id,
        razorpayPaymentId: razorpay_payment_id
      });
      res.status(200).json({ success: true, message: 'Payment verified successfully' });
    } else {
      res.status(400).json({ success: false, message: 'Invalid signature' });
    }
  } catch (error) {
    console.error('Error verifying payment:', error);
    res.status(500).json({ success: false, message: 'Payment verification failed' });
  }
});

app.post('/api/contact', async (req, res) => {
  try {
    const { user_name, user_email, message } = req.body;
    const contactEntry = new Contact({ name: user_name, email: user_email, message });
    await contactEntry.save();

    const mailOptions = {
      from: user_email,
      to: process.env.EMAIL_USER || 'akhilthadaka97@gmail.com',
      subject: `New Contact from Sherlock's Life: ${user_name}`,
      html: `
        <h3>New Message Received</h3>
        <p><strong>Name:</strong> ${user_name}</p>
        <p><strong>Email:</strong> ${user_email}</p>
        <p><strong>Message:</strong></p>
        <p>${message}</p>
      `,
    };

    await transporter.sendMail(mailOptions);
    res.status(200).json({ success: true, message: 'Contact message saved and email sent!' });
  } catch (error) {
    console.error('Contact Form Error:', error);
    res.status(500).json({ success: false, message: 'Failed to process contact message' });
  }
});



// --- Admin Schema ---
const adminSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  email: { type: String, default: 'akhilthadaka97@gmail.com' }
});
const Admin = mongoose.model('Admin', adminSchema);

// Initial Admin Creation (Run once)
const initAdmin = async () => {
  const existing = await Admin.findOne({ username: 'admin' });
  if (!existing) {
    const hashedPassword = await bcrypt.hash('admin123', 10);
    await Admin.create({ username: 'admin', password: hashedPassword, email: 'akhilthadaka97@gmail.com' });
    console.log('👤 Default Admin Created: admin / admin123');
  }
};
initAdmin();

/**
 * NOTE:
 * Frontend admin login currently stores a "fake token" in localStorage named `adminToken`
 * by doing: btoa(JSON.stringify({ identity, ts, exp }))
 *
 * Backend can also support real JWT tokens (created in /api/admin/login and /api/admin/firebase-login).
 * This middleware accepts BOTH token formats.
 */
const ADMIN_FIREBASE_EMAIL = 'akhilthadaka97@gmail.com';
const ADMIN_IDENTITY = 'admin';

const safeDecodeBase64Json = (b64) => {
  try {
    const normalized = b64.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '==='.slice((normalized.length + 3) % 4);
    const json = Buffer.from(padded, 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
};

// --- Auth Middleware ---
const authenticateAdmin = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'No token provided' });

  // 1) Try real JWT first
  jwt.verify(token, process.env.JWT_SECRET || 'sherlock_secret', (err, decoded) => {
    if (!err && decoded?.id) {
      req.adminId = decoded.id;
      return next();
    }

    // 2) Fallback: accept frontend base64 token
    const payload = safeDecodeBase64Json(token);
    if (!payload?.identity || !payload?.exp) {
      return res.status(401).json({ message: 'Invalid token' });
    }

    const now = Date.now();
    const expMs = typeof payload.exp === 'number' ? payload.exp : Number(payload.exp);
    if (!Number.isFinite(expMs) || expMs < now) {
      return res.status(401).json({ message: 'Token expired' });
    }

    // Strict Firebase admin identity check
    const identity = payload.identity;
    if (identity !== ADMIN_FIREBASE_EMAIL && identity !== ADMIN_IDENTITY) {
      return res.status(403).json({ message: 'Access Denied: Not authorized admin.' });
    }

    // This base64 token doesn't include a real Mongo adminId; allow admin routes anyway.
    req.adminId = payload.identity;
    next();
  });
};

// --- Admin Routes ---

// Login
app.post('/api/admin/login', async (req, res) => {
  const { username, password, email } = req.body;

  // Firebase/Google Login Restriction
  if (email && email !== ADMIN_FIREBASE_EMAIL) {
    return res.status(403).json({ success: false, message: 'You are not the admin' });
  }

  // Regular JWT Login
  const admin = await Admin.findOne({ username });
  if (!admin || !(await bcrypt.compare(password, admin.password))) {
    return res.status(401).json({ success: false, message: 'Invalid credentials' });
  }

  const token = jwt.sign({ id: admin._id }, process.env.JWT_SECRET || 'sherlock_secret', { expiresIn: '1d' });
  res.json({ success: true, token });
});

// Firebase Special Login
app.post('/api/admin/firebase-login', async (req, res) => {
  const { email } = req.body;

  if (email !== ADMIN_FIREBASE_EMAIL) {
    return res.status(403).json({
      success: false,
      message: `Access Denied: Only ${ADMIN_FIREBASE_EMAIL} can access this panel.`,
    });
  }

  try {
    // Find admin by email; if missing, auto-provision so Firebase login works.
    let admin = await Admin.findOne({ email });

    if (!admin) {
      const hashedPassword = await bcrypt.hash(crypto.randomBytes(16).toString('hex'), 10);
      admin = await Admin.create({
        username: 'admin',
        password: hashedPassword,
        email: email,
      });
      console.log('👤 Admin auto-created for Firebase email:', email);
    }

    const token = jwt.sign(
      { id: admin._id },
      process.env.JWT_SECRET || 'sherlock_secret',
      { expiresIn: '1d' }
    );

    return res.json({ success: true, token });
  } catch (err) {
    console.error('Firebase login error:', err);
    return res.status(500).json({ success: false, message: 'Authentication failed.' });
  }
});

// Notifications (Last 24 hours)
app.get('/api/admin/notifications', authenticateAdmin, async (req, res) => {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const newContacts = await Contact.find({ createdAt: { $gte: yesterday } }).sort('-createdAt');
  const newSubsidies = await SubsidyForm.find({ createdAt: { $gte: yesterday } }).sort('-createdAt');
  
  res.json({
    success: true,
    notifications: [
      ...newContacts.map(c => ({ type: 'contact', name: c.name, time: c.createdAt })),
      ...newSubsidies.map(s => ({ type: 'subsidy', name: s.u_name, time: s.createdAt }))
    ]
  });
});

// Contacts (Paginated)
app.get('/api/admin/contacts', authenticateAdmin, async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = 15;
  const skip = (page - 1) * limit;

  const total = await Contact.countDocuments();
  const contacts = await Contact.find().sort('-createdAt').skip(skip).limit(limit);

  res.json({ success: true, contacts, total, pages: Math.ceil(total / limit) });
});

// Subsidies (Paginated)
app.get('/api/admin/subsidies', authenticateAdmin, async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = 15;
  const skip = (page - 1) * limit;

  const total = await SubsidyForm.countDocuments();
  const subsidies = await SubsidyForm.find().sort('-createdAt').skip(skip).limit(limit);

  res.json({ success: true, subsidies, total, pages: Math.ceil(total / limit) });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✅ Backend Server running on http://localhost:${PORT}`);
});
