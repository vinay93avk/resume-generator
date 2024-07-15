const express = require('express');
const router = express.Router();
const axios = require('axios');
const mysql = require('mysql2');
const bcrypt = require('bcrypt');
const dbConfig = {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
};

const connection = mysql.createConnection(dbConfig);

router.get('/', (req, res) => {
  res.render('index');
});

router.get('/login', (req, res) => {
  res.render('login');
});

router.get('/signup', (req, res) => {
  res.render('signup');
});

router.post('/signup', async (req, res) => {
  const { firstName, lastName, username, email, password, phone } = req.body;

  if (!email.endsWith('@eagles.oc.edu')) {
    return res.status(400).send('Please enter a valid OC email');
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

router.post('/login', async (req, res) => {
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

router.get('/resume', (req, res) => {
  if (!req.session.user) {
    return res.redirect('/login'); // Redirect to login if the user is not logged in
  }
  res.render('resume', { user: req.session.user });
});

router.post('/generate_resume', async (req, res) => {
  const { degree, institution, startDate, endDate, company_name, role, experience_start_date, experience_end_date, description, skills, linkedUrl, jobDescription } = req.body;
  const { firstName, lastName, email, phone } = req.session.user;

  if (!firstName || !lastName || !email || !phone || !degree || !institution || !startDate || !endDate || !company_name || !role || !experience_start_date || !experience_end_date || !skills || !jobDescription) {
    return res.status(400).send('All fields are required');
  }

  const prompt = `Generate concise bullet points for the experience section based on experience at ${company_name} as a ${role} from ${experience_start_date} to ${experience_end_date}, a ${degree} from ${institution}, and skills in ${skills}. Ensure the points align with the following job description: ${jobDescription}.`;

  try {
    const response = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: prompt }
      ]
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    const experienceDescription = response.data.choices[0].message.content.trim();
    const experiencePoints = experienceDescription
      .split('\n')
      .map(point => point.trim().replace(/^- /, '').replace(/\.$/, '').trim() + '.')
      .filter(line => line.trim() !== '.');

    const user = req.session.user;

    const insertEducationQuery = 'INSERT INTO Education (user_id, degree, institution, start_date, end_date, email) VALUES (?, ?, ?, ?, ?, ?)';
    const educationValues = [user.id, degree, institution, startDate, endDate, email];
    connection.query(insertEducationQuery, educationValues, (error, results) => {
      if (error) {
        console.error('Error saving education:', error);
        return res.status(500).send('Error saving education');
      }

      const insertExperienceQuery = 'INSERT INTO Experience (user_id, company_name, role, start_date, end_date, description, email) VALUES (?, ?, ?, ?, ?, ?, ?)';
      const experienceValues = [user.id, company_name, role, experience_start_date, experience_end_date, description, email];
      connection.query(insertExperienceQuery, experienceValues, (error, results) => {
        if (error) {
          console.error('Error saving experience:', error);
          return res.status(500).send('Error saving experience');
        }
        
        const insertResumeQuery = 'INSERT INTO resumes (user_id, firstName, lastName, email, phone, skills, linkedUrl, experience) VALUES (?, ?, ?, ?, ?, ?, ?, ?)';
        const resumeValues = [user.id, firstName, lastName, email, phone, skills, linkedUrl, experience];
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
            degree,
            institution,
            startDate,
            endDate,
            company_name,
            role,
            experience_start_date,
            experience_end_date,
            description: experiencePoints,
            skills,
            linkedUrl
          });
        });
      });
    });
  } catch (error) {
    console.error('Error generating description:', error);
    res.status(500).send('Error generating description');
  }
});

router.get('/user-count', (req, res) => {
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

router.get('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).send('Failed to logout');
    }
    res.redirect('/');
  });
});

router.get('/user/:email/education', (req, res) => {
  const email = req.params.email;
  const query = 'SELECT degree, institution, start_date, end_date FROM Education e JOIN users u ON e.user_id = u.id WHERE u.email = ?';

  connection.query(query, [email], (error, results) => {
    if (error) {
      console.error('Error querying the database:', error);
      return res.status(500).send('Error querying the database');
    }

    if (results.length === 0) {
      return res.status(404).send('No education found for the given email');
    }

    res.json(results[0]);
  });
});

router.get('/user/:email/experience', (req, res) => {
  const email = req.params.email;
  const query = 'SELECT company_name, role, start_date, end_date, description FROM Experience e JOIN users u ON e.user_id = u.id WHERE u.email = ?';

  connection.query(query, [email], (error, results) => {
    if (error) {
      console.error('Error querying the database:', error);
      return res.status(500).send('Error querying the database');
    }

    if (results.length === 0) {
      return res.status(404).send('No experience found for the given email');
    }

    res.json(results[0]);
  });
});

router.get('/user/:email/skills', (req, res) => {
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

router.get('/user/:email/phone', (req, res) => {
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
  
  router.get('/user/:email/linkedin', (req, res) => {
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
  
  router.get('/resume/:email', (req, res) => {
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
  
  router.get('/user/:email/degree', (req, res) => {
    const email = req.params.email;
    const query = 'SELECT degree FROM Education e JOIN users u ON e.user_id = u.id WHERE u.email = ?';
  
    connection.query(query, [email], (error, results) => {
      if (error) {
        console.error('Error querying the database:', error);
        return res.status(500).send('Error querying the database');
      }
  
      if (results.length === 0) {
        return res.status(404).send('No degree found for the given email');
      }
  
      res.json({ degree: results[0].degree });
    });
  });
  
  router.get('/user/:email/institution', (req, res) => {
    const email = req.params.email;
    const query = 'SELECT institution FROM Education e JOIN users u ON e.user_id = u.id WHERE u.email = ?';
  
    connection.query(query, [email], (error, results) => {
      if (error) {
        console.error('Error querying the database:', error);
        return res.status(500).send('Error querying the database');
      }
  
      if (results.length === 0) {
        return res.status(404).send('No institution found for the given email');
      }
  
      res.json({ institution: results[0].institution });
    });
  });
  
  router.get('/user/:email/start_date', (req, res) => {
    const email = req.params.email;
    const query = 'SELECT start_date FROM Education e JOIN users u ON e.user_id = u.id WHERE u.email = ?';
  
    connection.query(query, [email], (error, results) => {
      if (error) {
        console.error('Error querying the database:', error);
        return res.status(500).send('Error querying the database');
      }
  
      if (results.length === 0) {
        return res.status(404).send('No start date found for the given email');
      }
  
      res.json({ start_date: results[0].start_date });
    });
  });
  
  router.get('/user/:email/end_date', (req, res) => {
    const email = req.params.email;
    const query = 'SELECT end_date FROM Education e JOIN users u ON e.user_id = u.id WHERE u.email = ?';
  
    connection.query(query, [email], (error, results) => {
      if (error) {
        console.error('Error querying the database:', error);
        return res.status(500).send('Error querying the database');
      }
  
      if (results.length === 0) {
        return res.status(404).send('No end date found for the given email');
      }
  
      res.json({ end_date: results[0].end_date });
    });
  });
  
  router.get('/user/:email/experience', (req, res) => {
    const email = req.params.email;
    const query = 'SELECT company_name, role, start_date, end_date FROM Experience e JOIN users u ON e.user_id = u.id WHERE u.email = ?';
  
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
  
  router.get('/user/:email/skills', (req, res) => {
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
  
  router.get('/user/:email/phone', (req, res) => {
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
  
  router.get('/user/:email/linkedin', (req, res) => {
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
  
  module.exports = router;

