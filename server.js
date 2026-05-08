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
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import mongoSanitize from 'express-mongo-sanitize';
import { fileURLToPath } from 'url';

// ===============================
// Resolve __dirname for ES Modules
// ===============================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ===============================
// Load Environment Variables
// ===============================
dotenv.config({ path: path.join(__dirname, '.env') });

// ===============================
// Validate Required ENV Variables
// ===============================
const requiredEnv = [
  'MONGODB_URI',
  'JWT_SECRET',
  'EMAIL_USER',
  'EMAIL_PASS',
  'RAZORPAY_KEY_ID',
  'RAZORPAY_KEY_SECRET',
];

requiredEnv.forEach((key) => {
  if (!process.env[key]) {
    throw new Error(`❌ Missing required env variable: ${key}`);
  }
});

// ===============================
// App Setup
// ===============================
const app = express();

// ===============================
// Security Middleware
// ===============================
app.use(helmet());

app.use(
  cors({
    origin: process.env.CLIENT_URL || '*',
    credentials: true,
  })
);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(mongoSanitize());

// ===============================
// Rate Limiting
// ===============================
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many requests. Please try again later.',
});

app.use(limiter);

// ===============================
// Uploads Folder
// ===============================
const uploadDir = path.join(__dirname, 'uploads');

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}

app.use('/uploads', express.static(uploadDir));

// ===============================
// Multer Setup
// ===============================
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },

  filename: (req, file, cb) => {
    const uniqueSuffix =
      Date.now() + '-' + Math.round(Math.random() * 1e9);

    cb(
      null,
      file.fieldname +
        '-' +
        uniqueSuffix +
        path.extname(file.originalname)
    );
  },
});

const upload = multer({
  storage,

  limits: {
    fileSize: 5 * 1024 * 1024,
  },

  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|pdf/;

    const extname = allowedTypes.test(
      path.extname(file.originalname).toLowerCase()
    );

    const mimetype = allowedTypes.test(file.mimetype);

    if (extname && mimetype) {
      return cb(null, true);
    }

    cb(new Error('Only JPG, PNG, and PDF files are allowed.'));
  },
});

// ===============================
// MongoDB Connection
// ===============================
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch((err) => console.error('❌ MongoDB Error:', err));

// ===============================
// Schemas
// ===============================
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

  idProofUrls: [String],

  paymentStatus: {
    type: String,
    default: 'pending',
  },

  razorpayOrderId: String,
  razorpayPaymentId: String,

  amount: {
    type: Number,
    default: 4200,
  },

  createdAt: {
    type: Date,
    default: Date.now,
  },
});

const contactSchema = new mongoose.Schema({
  name: String,
  email: String,
  message: String,

  createdAt: {
    type: Date,
    default: Date.now,
  },
});

const adminSchema = new mongoose.Schema({
  username: {
    type: String,
    unique: true,
    required: true,
  },

  password: {
    type: String,
    required: true,
  },

  email: {
    type: String,
    required: true,
  },
});

const SubsidyForm = mongoose.model(
  'SubsidyForm',
  subsidySchema
);

const Contact = mongoose.model(
  'Contact',
  contactSchema
);

const Admin = mongoose.model(
  'Admin',
  adminSchema
);

// ===============================
// Razorpay Setup
// ===============================
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// ===============================
// Nodemailer Setup
// ===============================
const transporter = nodemailer.createTransport({
  service: 'gmail',

  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// ===============================
// Constants
// ===============================
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;

// ===============================
// Root Route
// ===============================
app.get('/', (req, res) => {
  res.send('✅ Sherlock Backend Running');
});

// ===============================
// Create Admin If Not Exists
// ===============================
const initAdmin = async () => {
  try {
    const existingAdmin = await Admin.findOne({
      username: process.env.ADMIN_USERNAME,
    });

    if (!existingAdmin) {
      const hashedPassword = await bcrypt.hash(
        process.env.ADMIN_PASSWORD,
        10
      );

      await Admin.create({
        username: process.env.ADMIN_USERNAME,
        password: hashedPassword,
        email: ADMIN_EMAIL,
      });

      console.log('✅ Default Admin Created');
    }
  } catch (error) {
    console.error('❌ Admin Init Error:', error);
  }
};

initAdmin();

// ===============================
// JWT Auth Middleware
// ===============================
const authenticateAdmin = async (
  req,
  res,
  next
) => {
  try {
    const token =
      req.headers.authorization?.split(' ')[1];

    if (!token) {
      return res
        .status(401)
        .json({ message: 'No token provided' });
    }

    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET
    );

    req.adminId = decoded.id;

    next();
  } catch (error) {
    res.status(401).json({
      success: false,
      message: 'Invalid or expired token',
    });
  }
};

// ===============================
// Subsidy Registration
// ===============================
app.post(
  '/api/subsidy/register',
  upload.array('idCards'),
  async (req, res) => {
    try {
      const filePaths = req.files
        ? req.files.map(
            (file) => `/uploads/${file.filename}`
          )
        : [];

      const subsidyData = new SubsidyForm({
        ...req.body,

        roles: JSON.parse(
          req.body.roles || '[]'
        ),

        idProofUrls: filePaths,
      });

      const savedForm = await subsidyData.save();

      res.status(201).json({
        success: true,
        formId: savedForm._id,
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        success: false,
        message: 'Failed to register subsidy',
      });
    }
  }
);

// ===============================
// Create Razorpay Order
// ===============================
app.post(
  '/api/payment/create-order',
  async (req, res) => {
    try {
      const { amount } = req.body;

      const options = {
        amount: amount * 100,
        currency: 'INR',
        receipt: `receipt_${Date.now()}`,
      };

      const order =
        await razorpay.orders.create(options);

      res.json({
        success: true,
        order,
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        success: false,
        message: 'Order creation failed',
      });
    }
  }
);

// ===============================
// Verify Payment
// ===============================
app.post(
  '/api/payment/verify',
  async (req, res) => {
    try {
      const {
        razorpay_order_id,
        razorpay_payment_id,
        razorpay_signature,
        formId,
      } = req.body;

      const body =
        razorpay_order_id +
        '|' +
        razorpay_payment_id;

      const expectedSignature = crypto
        .createHmac(
          'sha256',
          process.env.RAZORPAY_KEY_SECRET
        )
        .update(body.toString())
        .digest('hex');

      if (
        expectedSignature !== razorpay_signature
      ) {
        return res.status(400).json({
          success: false,
          message: 'Invalid payment signature',
        });
      }

      await SubsidyForm.findByIdAndUpdate(
        formId,
        {
          paymentStatus: 'completed',
          razorpayOrderId: razorpay_order_id,
          razorpayPaymentId:
            razorpay_payment_id,
        }
      );

      res.json({
        success: true,
        message: 'Payment verified',
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        success: false,
        message: 'Payment verification failed',
      });
    }
  }
);

// ===============================
// Contact Form
// ===============================
app.post('/api/contact', async (req, res) => {
  try {
    const {
      user_name,
      user_email,
      message,
    } = req.body;

    const contactEntry = new Contact({
      name: user_name,
      email: user_email,
      message,
    });

    await contactEntry.save();

    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: ADMIN_EMAIL,

      subject: `New Contact from ${user_name}`,

      html: `
        <h2>New Contact Message</h2>

        <p><strong>Name:</strong> ${user_name}</p>

        <p><strong>Email:</strong> ${user_email}</p>

        <p><strong>Message:</strong></p>

        <p>${message}</p>
      `,
    });

    res.json({
      success: true,
      message: 'Message sent successfully',
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      message: 'Failed to process message',
    });
  }
});

// ===============================
// Admin Login
// ===============================
app.post('/api/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    const admin = await Admin.findOne({
      username,
    });

    if (!admin) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials',
      });
    }

    const isMatch = await bcrypt.compare(
      password,
      admin.password
    );

    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials',
      });
    }

    const token = jwt.sign(
      {
        id: admin._id,
      },

      process.env.JWT_SECRET,

      {
        expiresIn: '1d',
      }
    );

    res.json({
      success: true,
      token,
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      message: 'Login failed',
    });
  }
});

// ===============================
// Notifications
// ===============================
app.get(
  '/api/admin/notifications',
  authenticateAdmin,
  async (req, res) => {
    try {
      const yesterday = new Date(
        Date.now() - 24 * 60 * 60 * 1000
      );

      const newContacts = await Contact.find({
        createdAt: { $gte: yesterday },
      }).sort('-createdAt');

      const newSubsidies =
        await SubsidyForm.find({
          createdAt: { $gte: yesterday },
        }).sort('-createdAt');

      res.json({
        success: true,

        notifications: [
          ...newContacts.map((c) => ({
            type: 'contact',
            name: c.name,
            time: c.createdAt,
          })),

          ...newSubsidies.map((s) => ({
            type: 'subsidy',
            name: s.u_name,
            time: s.createdAt,
          })),
        ],
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        success: false,
        message: 'Failed to fetch notifications',
      });
    }
  }
);

// ===============================
// Admin Contacts
// ===============================
app.get(
  '/api/admin/contacts',
  authenticateAdmin,
  async (req, res) => {
    try {
      const page =
        parseInt(req.query.page) || 1;

      const limit = 15;

      const skip = (page - 1) * limit;

      const total =
        await Contact.countDocuments();

      const contacts = await Contact.find()
        .sort('-createdAt')
        .skip(skip)
        .limit(limit);

      res.json({
        success: true,
        contacts,
        total,
        pages: Math.ceil(total / limit),
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        success: false,
        message: 'Failed to fetch contacts',
      });
    }
  }
);

// ===============================
// Admin Subsidies
// ===============================
app.get(
  '/api/admin/subsidies',
  authenticateAdmin,
  async (req, res) => {
    try {
      const page =
        parseInt(req.query.page) || 1;

      const limit = 15;

      const skip = (page - 1) * limit;

      const total =
        await SubsidyForm.countDocuments();

      const subsidies =
        await SubsidyForm.find()
          .sort('-createdAt')
          .skip(skip)
          .limit(limit);

      res.json({
        success: true,
        subsidies,
        total,
        pages: Math.ceil(total / limit),
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        success: false,
        message: 'Failed to fetch subsidies',
      });
    }
  }
);

// ===============================
// Global Error Handler
// ===============================
app.use((err, req, res, next) => {
  console.error(err);

  res.status(500).json({
    success: false,
    message: err.message || 'Server Error',
  });
});

// ===============================
// Start Server
// ===============================
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(
    `✅ Server running on port ${PORT}`
  );
});
