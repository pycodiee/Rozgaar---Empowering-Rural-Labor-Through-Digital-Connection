import express from "express";
import bodyParser from "body-parser";
import pg from "pg";
import bcrypt from "bcrypt";
import passport from "passport";
import { Strategy as LocalStrategy } from "passport-local";
import { Strategy as GoogleStrategy } from "passport-google-oauth2";
import session from "express-session";
import env from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import multer from 'multer';
import { Buffer } from 'buffer';
import Stripe from 'stripe';
import fs from 'fs';
import _ from 'underscore';
import http from 'http';
import { Server } from 'socket.io';
import { v4 as uuidV4 } from 'uuid';

// Load environment variables first
env.config();

// Initialize express app first
const app = express();

// Then create the server and Socket.IO instance
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.NODE_ENV === 'production' 
      ? process.env.PRODUCTION_URL 
      : "http://localhost:3000",
    methods: ["GET", "POST"]
  }
});

// Initialize other constants
const stripe = new Stripe(process.env.STRIPE_KEY);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const port = process.env.PORT || 3000;
const saltRounds = 10;

// Store active rooms and users
const rooms = new Map();

// Database connection setup
const { Client } = pg;
const db = new Client({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT || 5432, 
});

// Connect to database
db.connect()
  .then(() => console.log("Connected to the database"))
  .catch((err) => console.error("Database connection error:", err));

// Helper function to calculate distance between coordinates
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
    Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}


// App configuration
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use('/images', express.static('images'));
app.use(express.static(path.join(__dirname, "public")));
app.use(express.static(path.join(__dirname, "webrtc")));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json());

// Configure multer for memory storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only images are allowed'));
    }
  }
});

// WebRTC Routes
app.get('/views/webrtc/index', (req, res) => {
  // Generate a new room ID and redirect to it
  res.redirect(`/views/webrtc/index/${uuidV4()}`);
});


// Socket.IO connection handling
io.on('connection', socket => {
  socket.on('join-room', (roomId, userId) => {
    socket.join(roomId);
    
    // Add user to room
    if (!rooms.has(roomId)) {
      rooms.set(roomId, new Set());
    }
    rooms.get(roomId).add(userId);
    
    // Notify others in room
    socket.to(roomId).emit('user-connected', userId);
    
    socket.on('disconnect', () => {
      rooms.get(roomId)?.delete(userId);
      socket.to(roomId).emit('user-disconnected', userId);
    });
    
    // Forward signaling messages
    socket.on('offer', (offer) => {
      socket.to(roomId).emit('offer', offer, userId);
    });
    
    socket.on('answer', (answer) => {
      socket.to(roomId).emit('answer', answer, userId);
    });
    
    socket.on('ice-candidate', (candidate) => {
      socket.to(roomId).emit('ice-candidate', candidate, userId);
    });
  });
});

// Session configuration
app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === "production",
      maxAge: 24 * 60 * 60 * 1000,
      httpOnly: true,
    },
  })
);
app.use(passport.initialize());
app.use(passport.session());

// Generate unique room route
app.get('/video', (req, res) => {
  res.redirect(`/video/${uuidV4()}`);
});


io.on('connection', socket => {
  socket.on('join-room', (roomId, userId) => {
    socket.join(roomId);
    
    // Add user to room
    if (!rooms.has(roomId)) {
      rooms.set(roomId, new Set());
    }
    rooms.get(roomId).add(userId);
    
    // Notify others in room
    socket.to(roomId).emit('user-connected', userId);
    
    socket.on('disconnect', () => {
      rooms.get(roomId)?.delete(userId);
      socket.to(roomId).emit('user-disconnected', userId);
    });
    
    // Forward signaling messages
    socket.on('offer', (offer) => {
      socket.to(roomId).emit('offer', offer, userId);
    });
    
    socket.on('answer', (answer) => {
      socket.to(roomId).emit('answer', answer, userId);
    });
    
    socket.on('ice-candidate', (candidate) => {
      socket.to(roomId).emit('ice-candidate', candidate, userId);
    });
  });
});

// Passport Local Strategy
passport.use(
  new LocalStrategy({ usernameField: "email" }, async (email, password, done) => {
    try {
      const result = await db.query("SELECT * FROM users WHERE email = $1", [email]);
      if (!result.rows.length) return done(null, false, { message: "Email not found" });

      const user = result.rows[0];
      if (!(await bcrypt.compare(password, user.password))) {
        return done(null, false, { message: "Incorrect password" });
      }
      return done(null, user);
    } catch (err) {
      return done(err);
    }
  })
);

// Passport Google Strategy
passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: process.env.GOOGLE_CALLBACK_URL,
      passReqToCallback: true,
    },
    async (request, accessToken, refreshToken, profile, done) => {
      try {
        const result = await db.query("SELECT * FROM users WHERE email = $1", [profile.emails[0].value]);
        if (result.rows.length) return done(null, result.rows[0]);

        const newUser = await db.query(
          "INSERT INTO users (email, full_name, password, provider, google_id, user_type) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *",
          [profile.emails[0].value, profile.displayName, "google", "google", profile.id, "client"]
        );

        return done(null, newUser.rows[0]);
      } catch (err) {
        return done(err);
      }
    }
  )
);

// Passport serialization
passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  try {
    const result = await db.query("SELECT * FROM users WHERE id = $1", [id]);
    done(null, result.rows[0]);
  } catch (err) {
    done(err);
  }
});

// Authentication middleware
const ensureAuthenticated = (req, res, next) => {
  if (req.isAuthenticated()) return next();
  req.session.returnTo = req.originalUrl;
  res.redirect("/login");
};

// Basic Routes
app.get("/", (req, res) => {
  if (req.isAuthenticated()) {
    res.redirect("/home");
  } else {
    res.redirect("/landing");
  }
});

app.get("/landing", (req, res) => {
  res.render("landing", {
    title: "Welcome to Rozgaar",
    user: req.user || null,
  });
});

app.get("/login", (req, res) => {
  res.render("login", {
    title: "Login - Rozgaar",
    error: req.query.error,
    user: req.user || null,
  });
});

app.get("/register", (req, res) => {
  res.render("register", {
    title: "Sign Up - Rozgaar",
    error: req.query.error,
    user: req.user || null,
  });
});

app.get("/logout", (req, res) => {
  res.render("logout", {
    title: "Logout - Rozgaar",
    error: req.query.error,
    user: req.user || null,
  });
});

app.post("/register", async (req, res) => {
  try {
    const { email, password, full_name, user_type } = req.body;
    
    // Check if user already exists
    const existingUser = await db.query("SELECT * FROM users WHERE email = $1", [email]);
    if (existingUser.rows.length) {
      return res.redirect("/register?error=Email+already+exists");
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    // Insert new user
    await db.query(
      "INSERT INTO users (email, password, full_name, user_type, provider) VALUES ($1, $2, $3, $4, $5)",
      [email, hashedPassword, full_name, user_type, "local"]
    );

    res.redirect("/login?success=Registration+successful");
  } catch (error) {
    console.error("Registration error:", error);
    res.redirect("/register?error=Registration+failed");
  }
});

app.post("/login",
  passport.authenticate("local", {
    successRedirect: "/home",
    failureRedirect: "/login?error=Invalid+credentials",
  })
);

app.get("/home", ensureAuthenticated, (req, res) => {
  res.render("home", { 
    title: "Home - Rozgaar",
    user: req.user,
    success: req.query.success, 
    error: req.query.error      
  });
});

app.get("/labour-profile", ensureAuthenticated, (req, res) => {
  res.render("labour-profile", { 
    title: "Labour - Profile",
    user: req.user,
    success: req.query.success, 
    error: req.query.error      
  });
});

app.get("/tracking", ensureAuthenticated, (req, res) => {
  res.render("tracking", { 
    title: "Track - Labour",
    user: req.user,
    success: req.query.success, 
    error: req.query.error      
  });
});

app.get('/views/webrtc/index', ensureAuthenticated, (req, res) => {
  res.render('vid', { 
      roomId: req.params.room,
      username: req.user.full_name,
      title: "Video Call - Rozgaar",
      user: req.user
  });
});

app.get("/payment", ensureAuthenticated, (req, res) => {
  res.render("payment", { 
    title: "Labour - Payment",
    user: req.user,
    success: req.query.success, 
    error: req.query.error      
  });
});

app.get('/views/webrtc/index', ensureAuthenticated, (req, res) => {
  res.render('/views/webrtc/index', {
      name: req.user.full_name, // Pass the user's name from the session
      users: {
          accepted: [
              { full_name: req.user.full_name }, // Current user
              // Add other accepted users as needed
          ],
          rejected: []
      },
      _: _ // Pass underscore library
  });
});

// Job Routes
app.get("/client-post", ensureAuthenticated, (req, res) => {
  if (req.user.user_type !== 'client') {
    return res.redirect('/home?error=Unauthorized+access');
  }
  res.render("client-post", { 
    title: "Post a Job - Rozgaar",
    user: req.user,
    googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY,
    error: req.query.error,
    success: req.query.success 
  });
});

app.get("/maps", ensureAuthenticated, (req, res) => {
  res.render("maps", { title: "Job Map", user: req.user });
});

app.post('/checkout', async (req, res) => {
    const session = await stripe.checkout.sessions.create({
        line_items: [
            {
                price_data: {
                    currency: 'usd',
                    product_data: {
                        name: 'Node.js and Express book'
                    },
                    unit_amount: 50 * 100
                },
                quantity: 1
            },
            {
                price_data: {
                    currency: 'usd',
                    product_data: {
                        name: 'JavaScript T-Shirt'
                    },
                    unit_amount: 20 * 100
                },
                quantity: 2
            }            
        ],
        mode: 'payment',
        shipping_address_collection: {
            allowed_countries: ['US', 'BR']
        },
        success_url: `${process.env.BASE_URL}/complete?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.BASE_URL}/cancel`
    })

    res.redirect(session.url)
})

app.get('/complete', async (req, res) => {
    const result = Promise.all([
        stripe.checkout.sessions.retrieve(req.query.session_id, { expand: ['payment_intent.payment_method'] }),
        stripe.checkout.sessions.listLineItems(req.query.session_id)
    ])

    console.log(JSON.stringify(await result))

    res.send('Your payment was successful')
})

app.get('/cancel', (req, res) => {
    res.redirect('/')
})

// Job Routes
app.get("/client-post", ensureAuthenticated, (req, res) => {
  if (req.user.user_type !== 'client') {
    return res.redirect('/home?error=Unauthorized+access');
  }
  res.render("client-post", { 
    title: "Post a Job - Rozgaar",
    user: req.user,
    googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY,
    error: req.query.error,
    success: req.query.success 
  });
});

app.post("/client-post", ensureAuthenticated, async (req, res) => {
  try {
      console.log("Received request body:", req.body);

      const {
          title,
          description,
          location,
          salary_range,
          requirements,
          category,
          location_type,
          start_date,
          duration,
          payment_type,
          latitude,
          longitude
      } = req.body;

      // Validate each field individually and log any missing fields
      const missingFields = [];
      if (!title) missingFields.push('title');
      if (!description) missingFields.push('description');
      if (!location) missingFields.push('location');
      if (!salary_range) missingFields.push('salary_range');
      if (!category) missingFields.push('category');
      if (!location_type) missingFields.push('location_type');
      if (!start_date) missingFields.push('start_date');
      if (!duration) missingFields.push('duration');
      if (!payment_type) missingFields.push('payment_type');
      if (!latitude) missingFields.push('latitude');
      if (!longitude) missingFields.push('longitude');

      if (missingFields.length > 0) {
          console.log("Missing fields:", missingFields);
          return res.status(400).json({
              error: `Missing required fields: ${missingFields.join(', ')}`
          });
      }

      // Log the parsed coordinates
      const lat = parseFloat(latitude);
      const lng = parseFloat(longitude);
      console.log("Parsed coordinates:", { lat, lng });

      // Log query and values before execution
      const query = `
          INSERT INTO jobs (
              title, description, location, salary_range, requirements, 
              posted_by, status, category, location_type, start_date, 
              duration, payment_type, latitude, longitude, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 
              $11, $12, $13, $14, NOW(), NOW()) RETURNING *;
      `;

      const values = [
          title,
          description,
          location,
          salary_range,
          requirements || "", 
          req.user.id,
          "open",
          category,
          location_type,
          start_date,
          duration,
          payment_type,
          lat,
          lng
      ];

      console.log("Executing query with values:", values);

      const result = await db.query(query, values);
      console.log("Job successfully stored in DB:", result.rows[0]);

      // Send JSON response instead of redirect
      return res.status(200).json({
          success: true,
          message: 'Job posted successfully',
          job: result.rows[0]
      });

  } catch (error) {
      console.error("Job posting error:", error);
      console.error("Error stack:", error.stack);
      // Send JSON response with error details
      return res.status(500).json({
          success: false,
          error: error.message || 'Failed to post job'
      });
  }
});

// Get all jobs
app.get("/api/jobs", async (req, res) => {
  try {
    const result = await db.query('SELECT id, title, description, location, salary_range, latitude, longitude FROM jobs');
    res.json(result.rows);
  } catch (error) {
    console.error("Error fetching jobs:", error);
    res.status(500).json({ error: 'Failed to fetch jobs' });
  }
});

// Get a specific job
app.get("/api/jobs/:id", async (req, res) => {
  try {
      const result = await pool.query(`
          SELECT j.*, u.full_name as poster_name, u.email as poster_email
          FROM jobs j
          JOIN users u ON j.posted_by = u.id
          WHERE j.id = $1
      `, [req.params.id]);

      if (result.rows.length === 0) {
          return res.status(404).json({ error: 'Job not found' });
      }

      res.json(result.rows[0]);
  } catch (error) {
      console.error("Error fetching job:", error);
      res.status(500).json({ error: 'Failed to fetch job details' });
  }
});

// Update a job
app.put("/api/jobs/:id", ensureAuthenticated, async (req, res) => {
  try {
      const jobId = req.params.id;
      const {
          title,
          description,
          location,
          salary_range,
          requirements,
          category,
          location_type,
          start_date,
          duration,
          payment_type,
          latitude,
          longitude,
          status
      } = req.body;

      // Check if user owns the job
      const jobCheck = await pool.query(
          'SELECT posted_by FROM jobs WHERE id = $1',
          [jobId]
      );

      if (jobCheck.rows.length === 0) {
          return res.status(404).json({ error: 'Job not found' });
      }

      if (jobCheck.rows[0].posted_by !== req.user.id) {
          return res.status(403).json({ error: 'Unauthorized to update this job' });
      }

      const result = await pool.query(
          `UPDATE jobs
          SET title = $1, description = $2, location = $3,
              salary_range = $4, requirements = $5, category = $6,
              location_type = $7, start_date = $8, duration = $9,
              payment_type = $10, latitude = $11, longitude = $12,
              status = $13, updated_at = CURRENT_TIMESTAMP
          WHERE id = $14 AND posted_by = $15
          RETURNING *`,
          [
              title, description, location, salary_range, requirements,
              category, location_type, start_date, duration,
              payment_type, latitude, longitude, status, jobId, req.user.id
          ]
      );

      res.json({
          success: true,
          message: 'Job updated successfully',
          job: result.rows[0]
      });
  } catch (error) {
      console.error("Error updating job:", error);
      res.status(500).json({ error: 'Failed to update job' });
  }
});

app.get("/labor-job-details/:id", ensureAuthenticated, async (req, res) => {
  try {
      const jobId = req.params.id;
      const result = await db.query(`
          SELECT j.*, u.full_name as poster_name, u.email as poster_email
          FROM jobs j
          JOIN users u ON j.posted_by = u.id
          WHERE j.id = $1
      `, [jobId]);

      if (result.rows.length === 0) {
          return res.status(404).render("404", { title: "Job Not Found", user: req.user });
      }

      res.render("labor-job-details", {
          title: "Job Details",
          user: req.user,
          job: result.rows[0],
          success: req.query.success,
          error: req.query.error
      });
  } catch (error) {
      console.error("Error fetching job details:", error);
      res.status(500).render("error", { title: "Server Error", user: req.user });
  }
});


app.post("/labour-profile", ensureAuthenticated, async (req, res) => {
  try {
    // Extract form data
    let {
      name,
      work_type,
      experience_level,
      location,
      working_days,
      working_times,
      languages
    } = req.body;

    // Convert single values to arrays where needed
    work_type = Array.isArray(work_type) ? work_type : [work_type].filter(Boolean);
    working_days = Array.isArray(working_days) ? working_days : [working_days].filter(Boolean);
    working_times = Array.isArray(working_times) ? working_times : [working_times].filter(Boolean);
    languages = Array.isArray(languages) ? languages : [languages].filter(Boolean);

    // Check if profile already exists
    const existingProfile = await db.query(
      "SELECT id FROM labour_profiles WHERE user_id = $1",
      [req.user.id]
    );

    let result;
    if (existingProfile.rows.length > 0) {
      // Update existing profile
      result = await db.query(
        `UPDATE labour_profiles 
         SET name = $1,
             work_type = $2,
             experience_level = $3,
             location = $4,
             working_days = $5,
             working_times = $6,
             languages = $7,
             updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $8
         RETURNING *`,
        [name, work_type, experience_level, location, working_days, working_times, languages, req.user.id]
      );
    } else {
      // Insert new profile
      result = await db.query(
        `INSERT INTO labour_profiles 
         (user_id, name, work_type, experience_level, location, working_days, working_times, languages)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [req.user.id, name, work_type, experience_level, location, working_days, working_times, languages]
      );
    }

    // Send JSON response for AJAX requests
    if (req.xhr || req.headers.accept.indexOf('json') > -1) {
      return res.json({
        success: true,
        message: 'Profile saved successfully',
        profile: result.rows[0]
      });
    }

    // Regular form submission redirect
    res.redirect("/labour-profile?success=Profile+saved+successfully");
  } catch (error) {
    console.error("Error saving labour profile:", error);
    
    // Send JSON response for AJAX requests
    if (req.xhr || req.headers.accept.indexOf('json') > -1) {
      return res.status(500).json({
        success: false,
        error: 'Failed to save profile'
      });
    }

    // Regular form submission redirect with error
    res.redirect("/labour-profile?error=Failed+to+save+profile");
  }
});
// Search jobs
app.get("/api/jobs/search", async (req, res) => {
  try {
      const {
          category,
          location,
          payment_type,
          location_type,
          status
      } = req.query;

      let query = `
          SELECT j.*, u.full_name as poster_name, u.email as poster_email
          FROM jobs j
          JOIN users u ON j.posted_by = u.id
          WHERE 1=1
      `;
      const values = [];
      let valueIndex = 1;

      if (category) {
          query += ` AND j.category = $${valueIndex}`;
          values.push(category);
          valueIndex++;
      }
      if (location) {
          query += ` AND j.location ILIKE $${valueIndex}`;
          values.push(`%${location}%`);
          valueIndex++;
      }
      if (payment_type) {
          query += ` AND j.payment_type = $${valueIndex}`;
          values.push(payment_type);
          valueIndex++;
      }
      if (location_type) {
          query += ` AND j.location_type = $${valueIndex}`;
          values.push(location_type);
          valueIndex++;
      }
      if (status) {
          query += ` AND j.status = $${valueIndex}`;
          values.push(status);
      }

      query += ' ORDER BY j.created_at DESC';

      const result = await pool.query(query, values);
      res.json(result.rows);
  } catch (error) {
      console.error("Error searching jobs:", error);
      res.status(500).json({ error: 'Failed to search jobs' });
  }
});

// In server.js - Add this new route for fetching map jobs
// Update these routes in server.js

// Main map route with initial data
// Update these routes in server.js

// Main map route with initial data
app.get("/maps", ensureAuthenticated, async (req, res) => {
  try {
    const query = `
      SELECT 
        j.*,
        u.full_name as poster_name,
        u.email as poster_email
      FROM jobs j
      LEFT JOIN users u ON j.posted_by = u.id
      WHERE j.status = 'open'
      ORDER BY j.created_at DESC
    `;
    
    const result = await db.query(query);
    
    res.render("maps", { 
      title: "Job Map", 
      user: req.user,
      initialJobs: result.rows,
      googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY 
    });
  } catch (error) {
    console.error("Error fetching initial jobs:", error);
    res.render("maps", { 
      title: "Job Map", 
      user: req.user,
      initialJobs: [],
      googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY
    });
  }
});

// API endpoint to fetch jobs for the map
app.get("/api/map-jobs", async (req, res) => {
  try {
    const query = `
      SELECT 
        j.*,
        u.full_name as poster_name,
        u.email as poster_email
      FROM jobs j
      LEFT JOIN users u ON j.posted_by = u.id
      WHERE j.status = 'open'
      ORDER BY j.created_at DESC
    `;
    
    const result = await db.query(query);
    res.json(result.rows);
  } catch (error) {
    console.error("Error fetching jobs for map:", error);
    res.status(500).json({ error: 'Failed to fetch jobs for map' });
  }
});

// Accept a job
app.post("/accept-job/:id", ensureAuthenticated, async (req, res) => {
    try {
        const jobId = req.params.id;

        // Update job status to accepted
        await db.query(`
            UPDATE jobs 
            SET status = 'accepted' 
            WHERE id = $1 AND posted_by != $2
        `, [jobId, req.user.id]);

        res.redirect(`/labor-job-details/${jobId}?success=Job+accepted+successfully`);
    } catch (error) {
        console.error("Error accepting job:", error);
        res.redirect(`/labor-job-details/${jobId}?error=Failed+to+accept+job`);
    }
});

// Google OAuth routes
app.get("/auth/google", passport.authenticate("google", { scope: ["email", "profile"] }));

app.get(
  "/auth/google/home",
  passport.authenticate("google", { failureRedirect: "/login" }),
  (req, res) => {
    res.redirect("/home");
  }
);

// Logout route
app.get("/logout", (req, res) => {
  req.logout(() => {
    res.redirect("/");
  });
});

// Error handling
app.use((req, res) => {
  res.status(404).render("404", {
    title: "Page Not Found - Rozgaar",
    user: req.user || null,
  });
});

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).render("error", {
    title: "Server Error - Rozgaar",
    user: req.user || null,
    error: "An internal server error occurred."
  });
});

// Get jobs for the map
app.get("/api/jobs/map", async (req, res) => {
    try {
        const result = await db.query(`
            SELECT * FROM jobs WHERE status = 'accepted'
        `);
        res.json(result.rows);
    } catch (error) {
        console.error("Error fetching jobs for map:", error);
        res.status(500).json({ error: 'Failed to fetch jobs for map' });
    }
});

// Server start
app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});

export default app;
