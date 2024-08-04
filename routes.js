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

      if (user.is_admin) {
        return res.redirect('/admin_dashboard'); // Redirect to admin dashboard if the user is an admin
      } else {
        // Check if resume exists
        const checkResumeQuery = 'SELECT s3_url FROM resumes WHERE user_id = ? ORDER BY created_at DESC LIMIT 1';
        connection.query(checkResumeQuery, [user.id], (resumeError, resumeResults) => {
          if (resumeError) {
            console.error('Error checking for resume:', resumeError);
            return res.status(500).send('Error checking for resume');
          }

          if (resumeResults.length > 0 && resumeResults[0].s3_url) {
            // Resume exists, redirect to show the resume
            return res.redirect('/show_resume');
          } else {
            // No resume found, redirect to resume creation page
            return res.redirect('/resume');
          }
        });
      }
    });
  });
});

router.get('/show_resume', (req, res) => {
  if (!req.session.user) {
    return res.redirect('/login'); // Redirect to login if the user is not logged in
  }

  const userId = req.session.user.id;

  const query = `
    SELECT resumes.id AS resumeId, resumes.s3_url, comments.comment, comments.created_at
    FROM resumes
    LEFT JOIN comments ON resumes.id = comments.resume_id
    WHERE resumes.user_id = ?
    ORDER BY resumes.created_at DESC, comments.created_at ASC
    LIMIT 1
  `;
  connection.query(query, [userId], (error, results) => {
    if (error) {
      console.error('Error fetching resume and comments:', error);
      return res.status(500).send('Error fetching resume and comments');
    }

    if (results.length === 0) {
      return res.render('show_resume', { pdfUrl: null, comments: [], resumeId: null });
    }

    const resumeData = results[0];
    const comments = results.map(row => ({ comment: row.comment, created_at: row.created_at })).filter(row => row.comment);

    res.render('show_resume', { pdfUrl: resumeData.s3_url, comments, resumeId: resumeData.resumeId });
  });
});


router.get('/admin_dashboard', (req, res) => {
  if (!req.session.user || !req.session.user.is_admin) {
    return res.status(403).send('Access denied');
  }

  const query = `
    SELECT users.firstName, users.lastName, resumes.id, resumes.s3_url, comments.comment, comments.created_at, comments.id AS commentId
    FROM resumes
    JOIN users ON resumes.user_id = users.id
    LEFT JOIN comments ON resumes.id = comments.resume_id
    ORDER BY resumes.created_at DESC
  `;
  connection.query(query, (error, results) => {
    if (error) {
      console.error('Error fetching all resumes:', error);
      return res.status(500).send('Error fetching all resumes');
    }

    const resumes = results.reduce((acc, row) => {
      const resume = acc.find(r => r.id === row.id);
      if (resume) {
        resume.comments.push({ comment: row.comment, created_at: row.created_at, id: row.commentId });
      } else {
        acc.push({
          id: row.id,
          firstName: row.firstName,
          lastName: row.lastName,
          s3_url: row.s3_url,
          comments: row.comment ? [{ comment: row.comment, created_at: row.created_at, id: row.commentId }] : []
        });
      }
      return acc;
    }, []);

    res.render('admin_dashboard', { resumes });
  });
});


router.post('/add_comment', (req, res) => {
  if (!req.session.user || !req.session.user.is_admin) {
    return res.status(403).send('Access denied');
  }

  const { resume_id, comment } = req.body;
  const admin_id = req.session.user.id;

  const query = 'INSERT INTO comments (resume_id, admin_id, comment) VALUES (?, ?, ?)';
  connection.query(query, [resume_id, admin_id, comment], (error, results) => {
    if (error) {
      console.error('Error adding comment:', error);
      return res.status(500).send('Error adding comment');
    }

    res.redirect('/admin_dashboard');
  });
});

// Route to display the edit form
router.get('/edit_comment/:id', (req, res) => {
  if (!req.session.user || !req.session.user.is_admin) {
      return res.status(403).send('Access denied');
  }

  const commentId = req.params.id;
  const query = 'SELECT * FROM comments WHERE id = ?';
  connection.query(query, [commentId], (error, results) => {
      if (error) {
          console.error('Error fetching comment:', error);
          return res.status(500).send('Error fetching comment');
      }

      if (results.length === 0) {
          return res.status(404).send('Comment not found');
      }

      res.render('edit_comment', { comment: results[0] });
  });
});

// Route to handle the submission of edited comments
router.post('/edit_comment/:id', (req, res) => {
  if (!req.session.user || !req.session.user.is_admin) {
      return res.status(403).send('Access denied');
  }

  const commentId = req.params.id;
  const updatedComment = req.body.comment;

  const query = 'UPDATE comments SET comment = ? WHERE id = ?';
  connection.query(query, [updatedComment, commentId], (error, results) => {
      if (error) {
          console.error('Error updating comment:', error);
          return res.status(500).send('Error updating comment');
      }

      res.redirect('/admin_dashboard');
  });
});


// Route to delete a comment
router.post('/delete_comment/:id', (req, res) => {
  if (!req.session.user || !req.session.user.is_admin) {
    return res.status(403).send('Access denied');
  }

  const commentId = req.params.id;

  const query = 'DELETE FROM comments WHERE id = ?';
  connection.query(query, [commentId], (error, results) => {
    if (error) {
      console.error('Error deleting comment:', error);
      return res.status(500).send('Error deleting comment');
    }

    res.redirect('/admin_dashboard');
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

function parseProjects(projectNames, githubLinks) {
  const projects = [];
  for (let i = 0; i < projectNames.length; i++) {
    projects.push({
      project_name: projectNames[i],
      github_link: githubLinks[i]
    });
  }
  return projects;
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
  const {
    degree, institution, startDate, endDate, company_name, role, experience_start_date,
    experience_end_date, description, skills, linkedUrl, jobDescription,
    certificate_name, issuing_organization, issue_date, expiration_date, project_name, github_link
  } = req.body;
  const { firstName, lastName, email, phone } = req.session.user;

  if (!firstName || !lastName || !email || !phone || !degree || !institution || !startDate || !endDate || !company_name || !role || !experience_start_date || !experience_end_date || !skills || !jobDescription) {
    return res.status(400).send('All fields are required');
  }

  const user = req.session.user;

  // Parsing Education, Experience, Skills, Certificates, and Projects
  const parsedEducation = parseEducation(degree, institution, startDate, endDate);
  const parsedExperience = parseExperience(company_name, role, experience_start_date, experience_end_date, description);
  const parsedSkills = parseSkills(skills);
  const parsedCertificates = parseCertificates(certificate_name, issuing_organization, issue_date, expiration_date);
  const parsedProjects = parseProjects(project_name, github_link);

  try {
    // Generate experience points for each experience entry
    const experiencePointsArray = await Promise.all(parsedExperience.map(exp => generateExperiencePoints(exp, jobDescription, skills)));

    // Add generated experience points to each experience entry
    parsedExperience.forEach((exp, index) => {
      exp.full_description = exp.description; // Store the user input in full_description
      if (experiencePointsArray[index]) {
        exp.description = experiencePointsArray[index].join('; '); // Replace this if your implementation of description involves experience points
      }
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
    const insertExperienceQuery = 'INSERT INTO Experience (user_id, company_name, role, start_date, end_date, description, full_description, email) VALUES ?';
    const experienceValues = parsedExperience.map(exp => [
      user.id,
      exp.company_name,
      exp.role,
      exp.start_date,
      exp.end_date,
      exp.description, // Summary or generated description
      exp.full_description, // Full user-provided description
      email
    ]);
    
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

    // Inserting Projects
    const insertProjectsQuery = 'INSERT INTO Projects (user_id, project_name, github_link) VALUES ?';
    const projectValues = parsedProjects.map(project => [user.id, project.project_name, project.github_link]);
    connection.query(insertProjectsQuery, [projectValues], (error, results) => {
      if (error) {
        console.error('Error saving projects:', error);
        return res.status(500).send('Error saving projects');
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

      // Render the resume to HTML for the web view
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
        certificates: parsedCertificates,
        projects: parsedProjects, // Include projects
        pdf: false,  // Indicate that this is for web rendering
        downloadUrl: '',  // Provide an empty default value for web rendering
        resumeId: resumeId
      }, async (err, html) => {
        if (err) {
          console.error('Error rendering resume HTML:', err);
          return res.status(500).send('Error rendering resume HTML');
        }

        try {
          // Render the resume to HTML for PDF generation
          const pdfHtml = await ejs.renderFile(path.join(__dirname, 'views', 'generated_resume.ejs'), {
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
            projects: parsedProjects, // Include projects
            pdf: true,
            resumeId: resumeId  // Indicate that this is for PDF generation
          });

          // Generate PDF from HTML
          const browser = await puppeteer.launch({
            args: ['--no-sandbox', '--disable-setuid-sandbox']
          });
          const page = await browser.newPage();
          await page.setContent(pdfHtml, { waitUntil: 'networkidle0' });

          // Add stylesheets to the page
          await page.addStyleTag({ path: path.join(__dirname, 'public', 'styles.css') });
          await page.addStyleTag({ path: path.join(__dirname, 'public', 'resume_styles.css') });

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
                projects: parsedProjects, // Include projects
                downloadUrl: data.Location,  // Provide the S3 URL for downloading
                pdf: false,
                resumeId: resumeId // Set pdf to false for web rendering
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

  // New routes to fetch skill_name and proficiency_level
  router.get('/user/:email/skills', (req, res) => {
    const email = req.params.email;
    const query = 'SELECT skill_name, proficiency_level FROM Skills s JOIN users u ON s.user_id = u.id WHERE u.email = ?';
  
    connection.query(query, [email], (error, results) => {
      if (error) {
        console.error('Error querying the database:', error);
        return res.status(500).send('Error querying the database');
      }
  
      if (results.length === 0) {
        return res.status(404).send('No skills found for the given email');
      }
  
      res.json(results);
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
  
  router.get('/user/:email/education/degrees', (req, res) => {
    const email = req.params.email;
    const query = `
        SELECT degree FROM Education e
        JOIN users u ON e.user_id = u.id
        WHERE u.email = ?;
    `;

    connection.query(query, [email], (error, results) => {
        if (error) {
            console.error('Error querying the database:', error);
            return res.status(500).send('Error querying the database');
        }

        if (results.length === 0) {
            return res.status(404).send('No degree found for the given email');
        }

        const degrees = results.map(row => row.degree);
        res.json({ degrees });
    });
});

  
router.get('/user/:email/education/institutions', (req, res) => {
    const email = req.params.email;
    const query = `
        SELECT institution FROM Education e
        JOIN users u ON e.user_id = u.id
        WHERE u.email = ?;
    `;

    connection.query(query, [email], (error, results) => {
        if (error) {
            console.error('Error querying the database:', error);
            return res.status(500).send('Error querying the database');
        }

        if (results.length === 0) {
            return res.status(404).send('No institution found for the given email');
        }

        const institutions = results.map(row => row.institution);
        res.json({ institutions });
    });
});


  
router.get('/user/:email/education/start_dates', (req, res) => {
    const email = req.params.email;
    const query = `
        SELECT DATE_FORMAT(start_date, "%Y-%m-%d") AS start_date FROM Education e
        JOIN users u ON e.user_id = u.id
        WHERE u.email = ?;
    `;

    connection.query(query, [email], (error, results) => {
        if (error) {
            console.error('Error querying the database:', error);
            return res.status(500).send('Error querying the database');
        }

        if (results.length === 0) {
            return res.status(404).send('No start date found for the given email');
        }

        const start_dates = results.map(row => row.start_date);
        res.json({ start_dates });
    });
});



  
router.get('/user/:email/education/end_dates', (req, res) => {
    const email = req.params.email;
    const query = `
        SELECT DATE_FORMAT(end_date, "%Y-%m-%d") AS end_date FROM Education e
        JOIN users u ON e.user_id = u.id
        WHERE u.email = ?;
    `;

    connection.query(query, [email], (error, results) => {
        if (error) {
            console.error('Error querying the database:', error);
            return res.status(500).send('Error querying the database');
        }

        if (results.length === 0) {
            return res.status(404).send('No end date found for the given email');
        }

        const end_dates = results.map(row => row.end_date);
        res.json({ end_dates });
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

  router.get('/user/:email/experience/company_name', (req, res) => {
    const email = req.params.email;
    const query = 'SELECT company_name FROM Experience e JOIN users u ON e.user_id = u.id WHERE u.email = ?';
  
    connection.query(query, [email], (error, results) => {
      if (error) {
        console.error('Error querying the database:', error);
        return res.status(500).send('Error querying the database');
      }
  
      if (results.length === 0) {
        return res.status(404).send('No company name found for the given email');
      }
  
      res.json({ company_name: results[0].company_name });
    });
  });
  
  router.get('/user/:email/experience/role', (req, res) => {
    const email = req.params.email;
    const query = 'SELECT role FROM Experience e JOIN users u ON e.user_id = u.id WHERE u.email = ?';
  
    connection.query(query, [email], (error, results) => {
      if (error) {
        console.error('Error querying the database:', error);
        return res.status(500).send('Error querying the database');
      }
  
      if (results.length === 0) {
        return res.status(404).send('No role found for the given email');
      }
  
      res.json({ role: results[0].role });
    });
  });
  
  router.get('/user/:email/experience/start_date', (req, res) => {
    const email = req.params.email;
    const query = 'SELECT DATE_FORMAT(start_date, "%Y-%m-%d") AS start_date FROM Experience e JOIN users u ON e.user_id = u.id WHERE u.email = ?';
  
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
  
  router.get('/user/:email/experience/end_date', (req, res) => {
    const email = req.params.email;
    const query = 'SELECT DATE_FORMAT(end_date, "%Y-%m-%d") AS end_date FROM Experience e JOIN users u ON e.user_id = u.id WHERE u.email = ?';
  
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

  // DELETE /user/:email/experience/:id
router.delete('/user/:email/experience/:id', (req, res) => {
    const email = req.params.email;
    const experience_id = req.params.id;

    const getUserIdQuery = 'SELECT id FROM users WHERE email = ?';
    connection.query(getUserIdQuery, [email], (error, results) => {
        if (error) {
            console.error('Error querying the database:', error);
            return res.status(500).send('Error querying the database');
        }

        if (results.length === 0) {
            return res.status(404).send('User not found');
        }

        const user_id = results[0].id;
        const deleteExperienceQuery = 'DELETE FROM Experience WHERE user_id = ? AND id = ?';

        connection.query(deleteExperienceQuery, [user_id, experience_id], (error, results) => {
            if (error) {
                console.error('Error deleting experience:', error);
                return res.status(500).send('Error deleting experience');
            }
            res.status(200).send('Experience deleted successfully');
        });
    });
});

// POST /user/:email/experience
router.post('/user/:email/experience', (req, res) => {
    const email = req.params.email;
    const { company_name, role, start_date, end_date, description } = req.body;

    console.log('Received data:', { company_name, role, start_date, end_date, description });

    if (!company_name || !role || !start_date || !end_date || !description) {
        return res.status(400).send('All fields are required');
    }

    const getUserIdQuery = 'SELECT id FROM users WHERE email = ?';
    connection.query(getUserIdQuery, [email], (error, results) => {
        if (error) {
            console.error('Error querying the database:', error);
            return res.status(500).send('Error querying the database');
        }

        if (results.length === 0) {
            return res.status(404).send('User not found');
        }

        const user_id = results[0].id;
        const insertExperienceQuery = 'INSERT INTO Experience (user_id, company_name, role, start_date, end_date, description, email) VALUES (?, ?, ?, ?, ?, ?, ?)';
        const values = [user_id, company_name, role, start_date, end_date, description, email];

        connection.query(insertExperienceQuery, values, (error, results) => {
            if (error) {
                console.error('Error inserting experience:', error);
                return res.status(500).send('Error inserting experience');
            }
            console.log('Experience added successfully:', results);
            res.status(201).send('Experience added successfully');
        });
    });
});

// PUT /user/:email/experience/:id
router.put('/user/:email/experience/:id', (req, res) => {
    const email = req.params.email;
    const experience_id = req.params.id;
    const { company_name, role, start_date, end_date, description } = req.body;

    console.log('Received data:', { company_name, role, start_date, end_date, description });

    if (!company_name || !role || !start_date || !end_date || !description) {
        return res.status(400).send('All fields are required');
    }

    const getUserIdQuery = 'SELECT id FROM users WHERE email = ?';
    connection.query(getUserIdQuery, [email], (error, results) => {
        if (error) {
            console.error('Error querying the database:', error);
            return res.status(500).send('Error querying the database');
        }

        if (results.length === 0) {
            return res.status(404).send('User not found');
        }

        const user_id = results[0].id;
        const updateExperienceQuery = 'UPDATE Experience SET company_name = ?, role = ?, start_date = ?, end_date = ?, description = ? WHERE user_id = ? AND id = ?';
        const values = [company_name, role, start_date, end_date, description, user_id, experience_id];

        connection.query(updateExperienceQuery, values, (error, results) => {
            if (error) {
                console.error('Error updating experience:', error);
                return res.status(500).send('Error updating experience');
            }
            res.status(200).send('Experience updated successfully');
        });
    });
});


  router.get('/user/:email/login_time', (req, res) => {
    const email = req.params.email;
    const query = 'SELECT DATE_FORMAT(s.login_time, "%Y-%m-%d %H:%i:%s") AS login_time FROM Sessions s JOIN users u ON s.user_id = u.id WHERE u.email = ? ORDER BY s.login_time DESC LIMIT 1';
  
    connection.query(query, [email], (error, results) => {
      if (error) {
        console.error('Error querying the database:', error);
        return res.status(500).send('Error querying the database');
      }
  
      if (results.length === 0) {
        return res.status(404).send('No login time found for the given email');
      }
  
      res.json({ login_time: results[0].login_time });
    });
  });
  
  router.get('/user/:email/logout_time', (req, res) => {
    const email = req.params.email;
    const query = 'SELECT DATE_FORMAT(s.logout_time, "%Y-%m-%d %H:%i:%s") AS logout_time FROM Sessions s JOIN users u ON s.user_id = u.id WHERE u.email = ? ORDER BY s.logout_time DESC LIMIT 1';
  
    connection.query(query, [email], (error, results) => {
      if (error) {
        console.error('Error querying the database:', error);
        return res.status(500).send('Error querying the database');
      }
  
      if (results.length === 0) {
        return res.status(404).send('No logout time found for the given email');
      }
  
      res.json({ logout_time: results[0].logout_time });
    });
  });

  router.get('/user/:email/skills', (req, res) => {
    const email = req.params.email;
    const query = 'SELECT skill_name, proficiency_level FROM Skills s JOIN users u ON s.user_id = u.id WHERE u.email = ?';
  
    connection.query(query, [email], (error, results) => {
      if (error) {
        console.error('Error querying the database:', error);
        return res.status(500).send('Error querying the database');
      }
  
      if (results.length === 0) {
        return res.status(404).send('No skills found for the given email');
      }
  
      res.json(results);
    });
  });
  
  router.get('/user/:email/proficiency_level/:skill_name', (req, res) => {
    const email = req.params.email;
    const skill_name = req.params.skill_name;
    const query = 'SELECT proficiency_level FROM Skills s JOIN users u ON s.user_id = u.id WHERE u.email = ? AND s.skill_name = ?';
  
    connection.query(query, [email, skill_name], (error, results) => {
      if (error) {
        console.error('Error querying the database:', error);
        return res.status(500).send('Error querying the database');
      }
  
      if (results.length === 0) {
        return res.status(404).send('No proficiency level found for the given skill and email');
      }
  
      res.json({ proficiency_level: results[0].proficiency_level });
    });
  });
  
  // Routes for fetching certificates
router.get('/user/:email/certificates', (req, res) => {
    const email = req.params.email;
    const query = 'SELECT certificate_name, issuing_organization, DATE_FORMAT(issue_date, "%Y-%m-%d") AS issue_date, DATE_FORMAT(expiration_date, "%Y-%m-%d") AS expiration_date FROM Certificates c JOIN users u ON c.user_id = u.id WHERE u.email = ?';
  
    connection.query(query, [email], (error, results) => {
      if (error) {
        console.error('Error querying the database:', error);
        return res.status(500).send('Error querying the database');
      }
  
      if (results.length === 0) {
        return res.status(404).send('No certificates found for the given email');
      }
  
      res.json(results);
    });
  });

  router.get('/user/:email/projects', (req, res) => {
    const email = req.params.email;
    const query = 'SELECT p.project_name, p.github_link FROM Projects p JOIN users u ON p.user_id = u.id WHERE u.email = ?';
    
    connection.query(query, [email], (error, results) => {
      if (error) {
        console.error('Error querying the database:', error);
        return res.status(500).send('Error querying the database');
      }
  
      if (results.length === 0) {
        return res.status(404).send('No projects found for the given email');
      }
  
      res.json(results);
    });
  });
  
  router.get('/user/:email/projects/names', (req, res) => {
    const email = req.params.email;
    const query = 'SELECT p.project_name FROM Projects p JOIN users u ON p.user_id = u.id WHERE u.email = ?';
  
    connection.query(query, [email], (error, results) => {
      if (error) {
        console.error('Error querying the database:', error);
        return res.status(500).send('Error querying the database');
      }
  
      if (results.length === 0) {
        return res.status(404).send('No project names found for the given email');
      }
  
      res.json(results.map(row => row.project_name));
    });
  });
  
  router.get('/user/:email/projects/github_links', (req, res) => {
    const email = req.params.email;
    const query = 'SELECT p.github_link FROM Projects p JOIN users u ON p.user_id = u.id WHERE u.email = ?';
  
    connection.query(query, [email], (error, results) => {
      if (error) {
        console.error('Error querying the database:', error);
        return res.status(500).send('Error querying the database');
      }
  
      if (results.length === 0) {
        return res.status(404).send('No GitHub links found for the given email');
      }
  
      res.json(results.map(row => row.github_link));
    });
  });
  
  router.get('/user/:email/projects/:project_name', (req, res) => {
    const { email, project_name } = req.params;
    const query = 'SELECT p.project_name, p.github_link FROM Projects p JOIN users u ON p.user_id = u.id WHERE u.email = ? AND p.project_name = ?';
  
    connection.query(query, [email, project_name], (error, results) => {
      if (error) {
        console.error('Error querying the database:', error);
        return res.status(500).send('Error querying the database');
      }
  
      if (results.length === 0) {
        return res.status(404).send('No details found for the given project');
      }
  
      res.json(results[0]);
    });
  });

// Show edit resume form
router.get('/edit_resume/:id', (req, res) => {
  const resumeId = req.params.id;
  const userId = req.session.user.id;

  const query = `
    SELECT resumes.*, 
          GROUP_CONCAT(DISTINCT CONCAT_WS(':', e.degree, e.institution, DATE_FORMAT(e.start_date, '%Y-%m-%d'), DATE_FORMAT(e.end_date, '%Y-%m-%d')) ORDER BY e.start_date SEPARATOR ';;') AS education,
          GROUP_CONCAT(DISTINCT CONCAT_WS(':', p.project_name, p.github_link) ORDER BY p.project_name SEPARATOR ';;') AS projects,
          GROUP_CONCAT(DISTINCT CONCAT_WS(':', exp.company_name, exp.role, DATE_FORMAT(exp.start_date, '%Y-%m-%d'), DATE_FORMAT(exp.end_date, '%Y-%m-%d'), exp.description) ORDER BY exp.start_date SEPARATOR ';;') AS experience,
          GROUP_CONCAT(DISTINCT CONCAT_WS(':', c.certificate_name, c.issuing_organization, DATE_FORMAT(c.issue_date, '%Y-%m-%d'), DATE_FORMAT(c.expiration_date, '%Y-%m-%d')) ORDER BY c.issue_date SEPARATOR ';;') AS certificates,
          GROUP_CONCAT(DISTINCT s.skill_name ORDER BY s.skill_name SEPARATOR ', ') AS skills
    FROM resumes
    LEFT JOIN Education e ON resumes.user_id = e.user_id
    LEFT JOIN Projects p ON resumes.user_id = p.user_id
    LEFT JOIN Experience exp ON resumes.user_id = exp.user_id
    LEFT JOIN Certificates c ON resumes.user_id = c.user_id
    LEFT JOIN Skills s ON resumes.user_id = s.user_id
    WHERE resumes.id = ? AND resumes.user_id = ?
    GROUP BY resumes.id
  `;

  connection.query(query, [resumeId, userId], (error, results) => {
    if (error) {
      console.error('Error fetching resume details:', error);
      return res.status(500).send('Error fetching resume details');
    }

    if (results.length === 0) {
      return res.status(404).send('Resume not found');
    }

    const resume = results[0];

    resume.education = resume.education ? resume.education.split(';;').map(edu => {
      const [degree, institution, start_date, end_date] = edu.split(':');
      return { degree, institution, start_date, end_date };
    }) : [];

    resume.projects = resume.projects ? resume.projects.split(';;').map(proj => {
      const [project_name, github_link] = proj.split(':');
      return { project_name, github_link };
    }) : [];

    resume.experience = resume.experience ? resume.experience.split(';;').map(exp => {
      const [company_name, role, start_date, end_date, description] = exp.split(':');
      return { company_name, role, start_date, end_date, description };
    }) : [];

    resume.certificates = resume.certificates ? resume.certificates.split(';;').map(cert => {
      const [certificate_name, issuing_organization, issue_date, expiration_date] = cert.split(':');
      return { certificate_name, issuing_organization, issue_date, expiration_date };
    }) : [];

    // Ensuring skills is an array of strings
    resume.skills = resume.skills ? resume.skills.split(',').map(skill => skill.trim()) : [];

    res.render('edit_resume', { resume });
  });
});

router.post('/update_generated_resume/:resumeId', async (req, res) => {
  const { resumeId } = req.params;
  const { firstName, lastName, email, phone, linkedUrl, skills, education, experience, certificates, projects } = req.body;

  const parsedSkills = parseSkills(skills);
  const parsedEducation = parseEducation(education);
  const parsedExperience = parseExperience(experience);
  const parsedCertificates = parseCertificates(certificates);
  const parsedProjects = parseProjects(projects);

  try {
    connection.beginTransaction(async (transactionErr) => {
      if (transactionErr) {
        console.error('Error starting transaction:', transactionErr);
        return res.status(500).send('Error starting transaction');
      }

      const updateQuery = `
        UPDATE resumes SET
          firstName = ?,
          lastName = ?,
          email = ?,
          phone = ?,
          linkedUrl = ?,
          skills = ?
        WHERE id = ? AND user_id = ?
      `;
      const updateValues = [
        firstName,
        lastName,
        email,
        phone,
        linkedUrl,
        skills,
        resumeId,
        req.user.id
      ];

      connection.query(updateQuery, updateValues, (updateErr) => {
        if (updateErr) {
          console.error('Error updating resume:', updateErr);
          return connection.rollback(() => {
            res.status(500).send('Error updating resume');
          });
        }

        const query = `
          SELECT resumes.*, 
                GROUP_CONCAT(DISTINCT CONCAT_WS(':', e.degree, e.institution, DATE_FORMAT(e.start_date, '%Y-%m-%d'), DATE_FORMAT(e.end_date, '%Y-%m-%d')) ORDER BY e.start_date SEPARATOR ';;') AS education,
                GROUP_CONCAT(DISTINCT CONCAT_WS(':', p.project_name, p.github_link) ORDER BY p.project_name SEPARATOR ';;') AS projects,
                GROUP_CONCAT(DISTINCT CONCAT_WS(':', exp.company_name, exp.role, DATE_FORMAT(exp.start_date, '%Y-%m-%d'), DATE_FORMAT(exp.end_date, '%Y-%m-%d'), exp.description) ORDER BY exp.start_date SEPARATOR ';;') AS experience,
                GROUP_CONCAT(DISTINCT CONCAT_WS(':', c.certificate_name, c.issuing_organization, DATE_FORMAT(c.issue_date, '%Y-%m-%d'), DATE_FORMAT(c.expiration_date, '%Y-%m-%d')) ORDER BY c.issue_date SEPARATOR ';;') AS certificates
          FROM resumes
          LEFT JOIN Education e ON resumes.user_id = e.user_id
          LEFT JOIN Projects p ON resumes.user_id = p.user_id
          LEFT JOIN Experience exp ON resumes.user_id = exp.user_id
          LEFT JOIN Certificates c ON resumes.user_id = c.user_id
          WHERE resumes.id = ? AND resumes.user_id = ?
          GROUP BY resumes.id
        `;

        connection.query(query, [resumeId, req.user.id], (error, results) => {
          if (error) {
            console.error('Error fetching updated resume details:', error);
            return connection.rollback(() => {
              res.status(500).send('Error fetching updated resume details');
            });
          }

          if (results.length === 0) {
            return connection.rollback(() => {
              res.status(404).send('Resume not found');
            });
          }

          const updatedResume = results[0];

          updatedResume.education = updatedResume.education ? updatedResume.education.split(';;').map(edu => {
            const [degree, institution, start_date, end_date] = edu.split(':');
            return { degree, institution, start_date, end_date };
          }) : [];

          updatedResume.projects = updatedResume.projects ? updatedResume.projects.split(';;').map(proj => {
            const [project_name, github_link] = proj.split(':');
            return { project_name, github_link };
          }) : [];

          updatedResume.experience = updatedResume.experience ? updatedResume.experience.split(';;').map(exp => {
            const [company_name, role, start_date, end_date, description] = exp.split(':');
            return { company_name, role, start_date, end_date, description };
          }) : [];

          updatedResume.certificates = updatedResume.certificates ? updatedResume.certificates.split(';;').map(cert => {
            const [certificate_name, issuing_organization, issue_date, expiration_date] = cert.split(':');
            return { certificate_name, issuing_organization, issue_date, expiration_date };
          }) : [];

          updatedResume.skills = updatedResume.skills ? updatedResume.skills.split(',').map(skill => skill.trim()) : [];

          connection.commit((err) => {
            if (err) {
              console.error('Error committing transaction:', err);
              return connection.rollback(() => {
                res.status(500).send('Error committing transaction');
              });
            }

            res.render('edit_resume', { resume: updatedResume });
          });
        });
      });
    });
  } catch (err) {
    console.error('Unexpected error:', err);
    res.status(500).send('Unexpected error');
  }
});

function parseSkills(skillsString) {
  return skillsString.split(',').map(skill => skill.trim());
}

function parseEducation(educationString) {
  return educationString.split(';;').map(edu => {
    const [degree, institution, start_date, end_date] = edu.split(':');
    return { degree, institution, start_date, end_date };
  });
}

function parseExperience(experienceString) {
  return experienceString.split(';;').map(exp => {
    const [company_name, role, start_date, end_date, description] = exp.split(':');
    return { company_name, role, start_date, end_date, description };
  });
}

function parseProjects(projectsString) {
  return projectsString.split(';;').map(proj => {
    const [project_name, github_link] = proj.split(':');
    return { project_name, github_link };
  });
}

function parseCertificates(certificatesString) {
  return certificatesString.split(';;').map(cert => {
    const [certificate_name, issuing_organization, issue_date, expiration_date] = cert.split(':');
    return { certificate_name, issuing_organization, issue_date, expiration_date };
  });
}






// Handle resume deletion
router.post('/delete_resume/:id', (req, res) => {
  const resumeId = req.params.id;

  const query = 'DELETE FROM resumes WHERE id = ? AND user_id = ?';
  connection.query(query, [resumeId, req.session.user.id], (error) => {
    if (error) {
      console.error('Error deleting resume:', error);
      return res.status(500).send('Error deleting resume');
    }

    // Render a confirmation page after deletion
    res.render('resume_deleted'); // You can change this view name as needed
  });
});


  
  module.exports = router;
