const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const mysql = require('mysql2');
const bcrypt = require('bcrypt');
const session = require('express-session');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const dbConfig = {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
};

if (!OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY is not defined');
  process.exit(1);
} else {
  console.log(`Using OPENAI_API_KEY: ${OPENAI_API_KEY}`);
}

const connection = mysql.createConnection(dbConfig);

connection.connect(error => {
  if (error) {
    console.error('Error connecting to the database:', error);
    process.exit(1);
  } else {
    console.log('Connected to the database');
  }
});

app.set('view engine', 'ejs');
app.use(bodyParser.urlencoded({ extended: true }));

app.use(session({
  secret: 'your-secret-key',
  resave: false,
  saveUninitialized: true,
}));

app.get('/', (req, res) => {
  res.render('index');
});

app.get('/login', (req, res) => {
  res.render('login');
});

app.get('/signup', (req, res) => {
  res.render('signup');
});

app.post('/signup', async (req, res) => {
  const { firstName, lastName, username, email, password, phone } = req.body;
  
  if (!email.endsWith('@eagles.oc.edu')) {
    return res.status(400).send('Please enter valid OC email');
  }
  
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const query = 'INSERT INTO users (firstName, lastName, username, email, hashed_password, phone) VALUES (?, ?, ?, ?, ?, ?)';
    const values = [firstName, lastName, username, email, hashedPassword, phone];
    
    connection.query(query, values, (error, results) => {
      if (error) {
        console.error('Error inserting user:', error);
        return res.status(500).send('Error inserting user');
      }
      res.redirect('/login');
    });
  } catch (error) {
    console.error('Error signing up:', error);
    res.status(500).send('Error signing up');
  }
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  
  const query = 'SELECT * FROM users WHERE email = ?';
  connection.query(query, [email], async (error, results) => {
    if (error) {
      console.error('Error querying the database:', error);
      return res.status(500).send('Error querying the database');
    }

    if (results.length === 0) {
      return res.status(401).send('Invalid email or password');
    }

    const user = results[0];
    const passwordMatch = await bcrypt.compare(password, user.hashed_password);

    if (!passwordMatch) {
      return res.status(401).send('Invalid email or password');
    }

    req.session.user = user; // Save the user information in the session
    res.redirect('/resume');
  });
});

app.get('/resume', (req, res) => {
  if (!req.session.user) {
    return res.redirect('/login'); // Redirect to login if the user is not logged in
  }
  res.render('resume', { user: req.session.user });
});

app.post('/generate_resume', async (req, res) => {
  const { education, experience, skills, linkedUrl } = req.body;
  const { firstName, lastName, email, phone } = req.session.user;

  if (!firstName || !lastName || !email || !phone || !education || !experience) {
    return res.status(400).send('All fields are required');
  }

  const prompt = `Generate concise bullet points for the experience section based on ${experience} of experience, a ${education}, and skills in ${skills}.`;

  try {
    const response = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: prompt }
      ]
    }, {
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    const experienceDescription = response.data.choices[0].message.content.trim();
    const experiencePoints = experienceDescription
      .split('\n')
      .map(point => point.trim().replace(/^- /, '').replace(/\.$/, '').trim() + '.')
      .filter(line => line.trim() !== '.');

    const user = req.session.user;

    const insertResumeQuery = 'INSERT INTO resumes (user_id, firstName, lastName, email, phone, education, experience, skills, linkedUrl) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)';
    const resumeValues = [user.id, firstName, lastName, email, phone, education, experiencePoints.join(' '), skills, linkedUrl];
    connection.query(insertResumeQuery, resumeValues, (error, results) => {
      if (error) {
        console.error('Error saving resume:', error);
        return res.status(500).send('Error saving resume');
      }
      res.render('generated_resume', {
        firstName,
        lastName,
        email,
        phone,
        education,
        experience: experiencePoints,
        skills,
        linkedUrl
      });
    });
  } catch (error) {
    console.error('Error generating description:', error);
    res.status(500).send('Error generating description');
  }
});

app.get('/user-count', (req, res) => {
  const query = 'SELECT COUNT(*) AS count FROM users';
  
  connection.query(query, (error, results) => {
    if (error) {
      console.error('Error querying the database:', error);
      return res.status(500).send('Error querying the database');
    }
    
    const count = results[0].count;
    res.json({ userCount: count });
  });
});

app.get('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).send('Failed to logout');
    }
    res.redirect('/');
  });
});

app.get('/user/:email/education', (req, res) => {
  const email = req.params.email;
  const query = 'SELECT education FROM resumes WHERE email = ?';
  
  connection.query(query, [email], (error, results) => {
    if (error) {
      console.error('Error querying the database:', error);
      return res.status(500).send('Error querying the database');
    }
    
    if (results.length === 0) {
      return res.status(404).send('No education found for the given email');
    }
    
    res.json({ education: results[0].education });
  });
});

app.get('/user/:email/experience', (req, res) => {
  const email = req.params.email;
  const query = 'SELECT experience FROM resumes WHERE email = ?';
  
  connection.query(query, [email], (error, results) => {
    if (error) {
      console.error('Error querying the database:', error);
      return res.status(500).send('Error querying the database');
    }
    
    if (results.length === 0) {
      return res.status(404).send('No experience found for the given email');
    }
    
    res.json({ experience: results[0].experience });
  });
});

app.get('/user/:email/skills', (req, res) => {
  const email = req.params.email;
  const query = 'SELECT skills FROM resumes WHERE email = ?';
  
  connection.query(query, [email], (error, results) => {
    if (error) {
      console.error('Error querying the database:', error);
      return res.status(500).send('Error querying the database');
    }
    
    if (results.length === 0) {
      return res.status(404).send('No skills found for the given email');
    }
    
    res.json({ skills: results[0].skills });
  });
});

app.get('/user/:email/phone', (req, res) => {
  const email = req.params.email;
  const query = 'SELECT phone FROM resumes WHERE email = ?';
  
  connection.query(query, [email], (error, results) => {
    if (error) {
      console.error('Error querying the database:', error);
      return res.status(500).send('Error querying the database');
    }
    
    if (results.length === 0) {
      return res.status(404).send('No phone found for the given email');
    }
    
    res.json({ phone: results[0].phone });
  });
});

app.get('/user/:email/linkedin', (req, res) => {
  const email = req.params.email;
  const query = 'SELECT linkedUrl FROM resumes WHERE email = ?';
  
  connection.query(query, [email], (error, results) => {
    if (error) {
      console.error('Error querying the database:', error);
      return res.status(500).send('Error querying the database');
    }
    
    if (results.length === 0) {
      return res.status(404).send('No LinkedIn URL found for the given email');
    }
    
    res.json({ linkedUrl: results[0].linkedUrl });
  });
});

app.get('/resume/:email', (req, res) => {
  const email = req.params.email;
  const query = 'SELECT * FROM resumes WHERE email = ?';

  connection.query(query, [email], (error, results) => {
    if (error) {
      console.error('Error querying the database:', error);
      return res.status(500).send('Error querying the database');
    }

    if (results.length === 0) {
      return res.status(404).send('No resume found for the given email');
    }

    res.json(results[0]);
  });
});

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});


