const express = require('express');
const axios = require('axios');
const path = require('path');
const bodyParser = require('body-parser');
require('dotenv').config();

const app = express();
const port = 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(bodyParser.urlencoded({ extended: true }));

const openaiApiKey = process.env.OPENAI_API_KEY;

app.get('/', (req, res) => {
    res.render('index');
});

app.post('/generate_resume', async (req, res) => {
    const { firstName, lastName, email, phone, education, experience } = req.body;

    if (!firstName || !lastName || !email || !phone || !education || !experience) {
        return res.status(400).send('All fields are required');
    }

    const prompt = `
        Generate concise bullet points for the following experience:
        ${experience}
        Ensure each bullet point is specific and clear, and avoid using any HTML tags.
    `;

    try {
        const response = await axios.post('https://api.openai.com/v1/chat/completions', {
            model: 'gpt-4',
            messages: [
                { role: 'system', content: 'You are a helpful assistant.' },
                { role: 'user', content: prompt }
            ]
        }, {
            headers: {
                'Authorization': `Bearer ${openaiApiKey}`
            }
        });

        const experienceDescription = response.data.choices[0].message.content.trim();
        const experiencePoints = experienceDescription.split('\n').map(point => point.replace(/^- /, '').trim());

        res.render('resume', {
            firstName,
            lastName,
            email,
            phone,
            education,
            experience: experiencePoints
        });
    } catch (error) {
        console.error('Error generating description:', error);
        res.status(500).send('Error generating description');
    }
});

app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});
