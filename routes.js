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

// Add this code snippet where appropriate in the existing routes.js file

// Function to handle splitting skills and proficiency levels
// Function to handle splitting skills and proficiency levels
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

// Modify the /generate_resume route
router.post('/generate_resume', async (req, res) => {
    const { degree, institution, startDate, endDate, company_name, role, experience_start_date, experience_end_date, description, skills, linkedUrl, jobDescription, certificate_name, issuing_organization, issue_date, expiration_date } = req.body;
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
            const experienceValues = [user.id, company_name, role, experience_start_date, experience_end_date, experiencePoints.join(' '), email];
            connection.query(insertExperienceQuery, experienceValues, (error, results) => {
                if (error) {
                    console.error('Error saving experience:', error);
                    return res.status(500).send('Error saving experience');
                }

                const parsedSkills = parseSkills(skills);
                const insertSkillsQuery = 'INSERT INTO Skills (user_id, email, skill_name, proficiency_level) VALUES (?, ?, ?, ?)';
                parsedSkills.forEach(skill => {
                    const skillValues = [user.id, email, skill.skill_name, skill.proficiency_level];
                    connection.query(insertSkillsQuery, skillValues, (error, results) => {
                        if (error) {
                            console.error('Error saving skill:', error);
                            return res.status(500).send('Error saving skill');
                        }
                    });
                });

                const parsedCertificates = parseCertificates(certificate_name, issuing_organization, issue_date, expiration_date);
                const insertCertificatesQuery = 'INSERT INTO Certificates (user_id, certificate_name, issuing_organization, issue_date, expiration_date, email) VALUES (?, ?, ?, ?, ?, ?)';
                parsedCertificates.forEach(cert => {
                    const certificateValues = [user.id, cert.certificate_name, cert.issuing_organization, cert.issue_date, cert.expiration_date, email];
                    connection.query(insertCertificatesQuery, certificateValues, (error, results) => {
                        if (error) {
                            console.error('Error saving certificate:', error);
                            return res.status(500).send('Error saving certificate');
                        }
                    });
                });

                const insertResumeQuery = 'INSERT INTO resumes (user_id, firstName, lastName, email, phone, degree, institution, start_date, end_date, experience, skills, linkedUrl) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
                const resumeValues = [user.id, firstName, lastName, email, phone, degree, institution, startDate, endDate, experiencePoints.join(' '), skills, linkedUrl];
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
                        skills: parsedSkills,
                        linkedUrl,
                        certificates: parsedCertificates
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
    const query = 'SELECT DATE_FORMAT(start_date, "%Y-%m-%d") AS start_date FROM Education e JOIN users u ON e.user_id = u.id WHERE u.email = ?';
  
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
    const query = 'SELECT DATE_FORMAT(end_date, "%Y-%m-%d") AS end_date FROM Education e JOIN users u ON e.user_id = u.id WHERE u.email = ?';
  
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
        const insertExperienceQuery = 'INSERT INTO Experience (user_id, company_name, role, start_date, end_date, description) VALUES (?, ?, ?, ?, ?, ?)';
        const values = [user_id, company_name, role, start_date, end_date, description];

        connection.query(insertExperienceQuery, values, (error, results) => {
            if (error) {
                console.error('Error inserting experience:', error);
                return res.status(500).send('Error inserting experience');
            }
            res.status(201).send('Experience added successfully');
        });
    });
});

// PUT /user/:email/experience/:id
router.put('/user/:email/experience/:id', (req, res) => {
    const email = req.params.email;
    const experience_id = req.params.id;
    const { company_name, role, start_date, end_date, description } = req.body;

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

  module.exports = router;
  
