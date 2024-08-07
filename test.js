const express = require('express');
const router = express.Router();
const axios = require('axios');
const mysql = require('mysql2');
const bcrypt = require('bcrypt');
const AWS = require('aws-sdk');
const ejs = require('ejs');
const path = require('path');
const puppeteer = require('puppeteer');

const dbConfig = {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
};

const connection = mysql.createConnection(dbConfig);
const s3 = new AWS.S3();

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

    // Insert login time into Sessions table
    const loginTime = new Date();
    const insertSessionQuery = 'INSERT INTO Sessions (user_id, email, login_time) VALUES (?, ?, ?)';
    connection.query(insertSessionQuery, [user.id, email, loginTime], (sessionError) => {
      if (sessionError) {
        console.error('Error inserting session:', sessionError);
        return res.status(500).send('Error inserting session');
      }
      res.redirect('/resume');
    });
  });
});

router.get('/logout', (req, res) => {
  if (req.session.user) {
    const user = req.session.user;
    const logoutTime = new Date();
    console.log(`Updating logout time for user: ${user.id}, email: ${user.email}, logoutTime: ${logoutTime}`);

    const updateLogoutQuery = 'UPDATE Sessions SET logout_time = ? WHERE user_id = ? AND email = ? AND logout_time IS NULL';
    connection.query(updateLogoutQuery, [logoutTime, user.id, user.email], (error, results) => {
      if (error) {
        console.error('Error updating session:', error);
        return res.status(500).send('Error updating session');
      }
      console.log('Logout time updated successfully');

      req.session.destroy((err) => {
        if (err) {
          return res.status(500).send('Failed to logout');
        }
        res.redirect('/');
      });
    });
  } else {
    res.redirect('/');
  }
});

router.get('/resume', (req, res) => {
  if (!req.session.user) {
    return res.redirect('/login'); // Redirect to login if the user is not logged in
  }
  res.render('resume', { user: req.session.user });
});

// Function to handle splitting skills
function parseSkills(skills) {
  return skills.split(',').map(skill => {
    const [skill_name, proficiency_level] = skill.split(':').map(s => s.trim());
    return { skill_name, proficiency_level };
  });
}

// Function to handle splitting certificates
function parseCertificates(certificateNames, issuingOrganizations, issueDates, expirationDates) {
  const certificates = [];
  for (let i = 0; i < certificateNames.length; i++) {
    certificates.push({
      certificate_name: certificateNames[i],
      issuing_organization: issuingOrganizations[i],
      issue_date: issueDates[i],
      expiration_date: expirationDates[i]
    });
  }
  return certificates;
}

// Function to handle splitting education
function parseEducation(degrees, institutions, startDates, endDates) {
  const education = [];
  for (let i = 0; i < degrees.length; i++) {
    education.push({
      degree: degrees[i],
      institution: institutions[i],
      start_date: startDates[i],
      end_date: endDates[i]
    });
  }
  return education;
}

// Function to handle splitting experience
function parseExperience(companyNames, roles, startDates, endDates, descriptions) {
  const experience = [];
  for (let i = 0; i < companyNames.length; i++) {
    experience.push({
      company_name: companyNames[i],
      role: roles[i],
      start_date: startDates[i],
      end_date: endDates[i],
      description: descriptions[i]
    });
  }
  return experience;
}

// Function to generate experience points for each experience
const generateExperiencePoints = async (exp, jobDescription, skills) => {
  const prompt = `Generate concise bullet points for the experience section based on experience at ${exp.company_name} as a ${exp.role} from ${exp.start_date} to ${exp.end_date}, and skills in ${skills}. Ensure the points align with the following job description: ${jobDescription}.`;

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

  return experiencePoints; // Return the array of points
};

// Route to generate and save resume
router.post('/generate_resume', async (req, res) => {
    const { degree, institution, startDate, endDate, company_name, role, experience_start_date, experience_end_date, description, skills, linkedUrl, jobDescription, certificate_name, issuing_organization, issue_date, expiration_date } = req.body;
    const { firstName, lastName, email, phone } = req.session.user;
  
    if (!firstName || !lastName || !email || !phone || !degree || !institution || !startDate || !endDate || !company_name || !role || !experience_start_date || !experience_end_date || !skills || !jobDescription) {
      return res.status(400).send('All fields are required');
    }
  
    const user = req.session.user;
  
    // Parsing Education, Experience, Skills, and Certificates
    const parsedEducation = parseEducation(degree, institution, startDate, endDate);
    const parsedExperience = parseExperience(company_name, role, experience_start_date, experience_end_date, description);
    const parsedSkills = parseSkills(skills);
    const parsedCertificates = parseCertificates(certificate_name, issuing_organization, issue_date, expiration_date);
  
    try {
      // Generate experience points for each experience entry
      const experiencePointsArray = await Promise.all(parsedExperience.map(exp => generateExperiencePoints(exp, jobDescription, skills)));
  
      // Add generated experience points to each experience entry
      parsedExperience.forEach((exp, index) => {
        exp.description = experiencePointsArray[index].join('; '); // Ensure it's a string
      });
  
      // Inserting Education
      const insertEducationQuery = 'INSERT INTO Education (user_id, degree, institution, start_date, end_date, email) VALUES ?';
      const educationValues = parsedEducation.map(edu => [user.id, edu.degree, edu.institution, edu.start_date, edu.end_date, email]);
      connection.query(insertEducationQuery, [educationValues], (error, results) => {
        if (error) {
          console.error('Error saving education:', error);
          return res.status(500).send('Error saving education');
        }
      });
  
      // Inserting Experience
      const insertExperienceQuery = 'INSERT INTO Experience (user_id, company_name, role, start_date, end_date, description, email) VALUES ?';
      const experienceValues = parsedExperience.map(exp => [user.id, exp.company_name, exp.role, exp.start_date, exp.end_date, exp.description, email]);
      connection.query(insertExperienceQuery, [experienceValues], (error, results) => {
        if (error) {
          console.error('Error saving experience:', error);
          return res.status(500).send('Error saving experience');
        }
      });
  
      // Inserting Skills
      const insertSkillsQuery = 'INSERT INTO Skills (user_id, email, skill_name, proficiency_level) VALUES ?';
      const skillValues = parsedSkills.map(skill => [user.id, email, skill.skill_name, skill.proficiency_level]);
      connection.query(insertSkillsQuery, [skillValues], (error, results) => {
        if (error) {
          console.error('Error saving skill:', error);
          return res.status(500).send('Error saving skill');
        }
      });
  
      // Inserting Certificates
      const insertCertificatesQuery = 'INSERT INTO Certificates (user_id, certificate_name, issuing_organization, issue_date, expiration_date, email) VALUES ?';
      const certificateValues = parsedCertificates.map(cert => [user.id, cert.certificate_name, cert.issuing_organization, cert.issue_date, cert.expiration_date, email]);
      connection.query(insertCertificatesQuery, [certificateValues], (error, results) => {
        if (error) {
          console.error('Error saving certificate:', error);
          return res.status(500).send('Error saving certificate');
        }
      });
  
      // Create combined descriptions for education and experience
      const educationDescription = parsedEducation.map(edu => `${edu.degree} from ${edu.institution} (${edu.start_date} to ${edu.end_date})`).join('; ');
      const experienceDescriptionCombined = parsedExperience.map(exp => `${exp.role} at ${exp.company_name} (${exp.start_date} to ${exp.end_date}): ${exp.description}`).join('; ');
  
      // Inserting into resumes table
      const insertResumeQuery = 'INSERT INTO resumes (user_id, firstName, lastName, email, phone, education, experience, skills, linkedUrl) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)';
      const resumeValues = [user.id, firstName, lastName, email, phone, educationDescription, experienceDescriptionCombined, skills, linkedUrl];
      connection.query(insertResumeQuery, resumeValues, (error, results) => {
        if (error) {
          console.error('Error saving resume:', error);
          return res.status(500).send('Error saving resume');
        }
  
        const resumeId = results.insertId;
  
        // Render the resume to HTML
        ejs.renderFile(path.join(__dirname, 'views', 'generated_resume.ejs'), {
          firstName,
          lastName,
          email,
          phone,
          education: parsedEducation,
          experience: parsedExperience.map(exp => ({
            ...exp,
            description: typeof exp.description === 'string' ? exp.description.split('; ').map(point => point.trim() + '.').filter(point => point.length > 1) : exp.description
          })),
          skills: parsedSkills,
          linkedUrl,
          certificates: parsedCertificates
        }, async (err, html) => {
          if (err) {
            console.error('Error rendering resume HTML:', err);
            return res.status(500).send('Error rendering resume HTML');
          }
  
          try {
            // Generate PDF from HTML
            const browser = await puppeteer.launch({
              args: ['--no-sandbox', '--disable-setuid-sandbox']
            });
            const page = await browser.newPage();
            await page.setContent(html, { waitUntil: 'networkidle0' });
            const pdfBuffer = await page.pdf({ format: 'A4' });
            await browser.close();
  
            // Upload PDF to S3
            const s3Params = {
              Bucket: 'resume-generator-ocu',
              Key: `resumes/${user.id}-${Date.now()}.pdf`,
              Body: pdfBuffer,
              ContentType: 'application/pdf'
            };
  
            s3.upload(s3Params, (s3Err, data) => {
              if (s3Err) {
                console.error('Error uploading PDF to S3:', s3Err);
                return res.status(500).send('Error uploading PDF to S3');
              }
  
              // Update the resumes table with the S3 URL
              const updateResumeQuery = 'UPDATE resumes SET s3_url = ? WHERE id = ?';
              connection.query(updateResumeQuery, [data.Location, resumeId], (updateErr) => {
                if (updateErr) {
                  console.error('Error updating resume with S3 URL:', updateErr);
                  return res.status(500).send('Error updating resume with S3 URL');
                }
  
                // Render the resume on the dashboard
                res.render('generated_resume', {
                  firstName,
                  lastName,
                  email,
                  phone,
                  education: parsedEducation,
                  experience: parsedExperience.map(exp => ({
                    ...exp,
                    description: typeof exp.description === 'string' ? exp.description.split('; ').map(point => point.trim() + '.').filter(point => point.length > 1) : exp.description
                  })),
                  skills: parsedSkills,
                  linkedUrl,
                  certificates: parsedCertificates,
                  downloadUrl: data.Location
                });
              });
            });
          } catch (error) {
            console.error('Error generating PDF:', error);
            res.status(500).send('Error generating PDF');
          }
        });
      });
    } catch (error) {
      console.error('Error generating description:', error);
      res.status(500).send('Error generating description');
    }
  });
  
  router.get('/download_resume', async (req, res) => {
    if (!req.session.user) {
      return res.redirect('/login'); // Redirect to login if the user is not logged in
    }
  
    const userId = req.session.user.id;
  
    const query = 'SELECT s3_url FROM resumes WHERE user_id = ? ORDER BY created_at DESC LIMIT 1';
    connection.query(query, [userId], (error, results) => {
      if (error) {
        console.error('Error fetching resume URL:', error);
        return res.status(500).send('Error fetching resume URL');
      }
  
      if (results.length === 0 || !results[0].s3_url) {
        return res.status(404).send('No resume found');
      }
  
      const pdfUrl = results[0].s3_url;
      res.redirect(pdfUrl); // Redirect the user to the S3 URL for downloading
    });
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
  
  router.get('/user/:email/education', (req, res) => {
    const email = req.params.email;
    const query = 'SELECT degree, institution, start_date, end_date FROM Education e JOIN users u ON e.user_id = u.id WHERE u.email = ?';
  
    connection.query(query,
  