require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs-extra');
const cron = require('node-cron');

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;

// File to persist last run timestamp
const LAST_RUN_FILE = './lastRun.json';
let lastRunTime = new Date().toISOString();

// Load last run time from file
if (fs.existsSync(LAST_RUN_FILE)) {
  const data = fs.readJSONSync(LAST_RUN_FILE);
  lastRunTime = data.lastRunTime;
}

// Store current access token
let accessToken = null;

// -------------------------
// 1️⃣ Refresh JobAdder Access Token
// -------------------------
async function refreshAccessToken() {
  const res = await axios.post('https://auth.jobadder.com/oauth2/token', null, {
    params: {
      grant_type: 'refresh_token',
      client_id: process.env.JOBADDER_CLIENT_ID,
      client_secret: process.env.JOBADDER_CLIENT_SECRET,
      refresh_token: process.env.JOBADDER_REFRESH_TOKEN
    }
  });
  accessToken = res.data.access_token;
  console.log('Refreshed JobAdder access token');
}

// -------------------------
// 2️⃣ Fetch Recently Updated Notes
// -------------------------
async function fetchRecentNotes() {
  if (!accessToken) await refreshAccessToken();

  console.log(`Fetching notes updated since ${lastRunTime}...`);
  
  const notesRes = await axios.get('https://api.jobadder.com/v2/notes', {
    headers: { Authorization: `Bearer ${accessToken}` },
    params: { dateFrom: lastRunTime }
  });

  const notes = notesRes.data.items;

  for (let note of notes) {
    if (
      note.type === 'Document Signed' &&
      note.document &&
      note.document.name.toLowerCase().includes('artisan_candidate_agreement')
    ) {
      const candidate = note.candidate;
      const dateSigned = new Date(note.dateCreated);
      const expiryDate = new Date(dateSigned);
      expiryDate.setFullYear(expiryDate.getFullYear() + 1);

      // Send to Google Sheet webhook
      try {
        await axios.post(process.env.GSHEET_WEBHOOK_URL, {
          candidateId: candidate.id,
          candidateName: candidate.firstName + ' ' + candidate.lastName,
          documentId: note.document.id,
          dateSigned: dateSigned.toISOString(),
          expiryDate: expiryDate.toISOString(),
          ownerEmail: candidate.owner ? candidate.owner.email : ''
        });
        console.log(`Sent ${candidate.firstName} ${candidate.lastName} to Sheet`);
      } catch (err) {
        console.error('Error sending to Google Sheet:', err.message);
      }

      // Optional: Update JobAdder custom field for expiry
      // await axios.patch(`https://api.jobadder.com/v2/candidates/${candidate.id}`, {
      //   customFields: { agreement_expiry_date: expiryDate.toISOString() }
      // }, { headers: { Authorization: `Bearer ${accessToken}` } });
    }
  }

  // Save current timestamp for next run
  lastRunTime = new Date().toISOString();
  fs.writeJSONSync(LAST_RUN_FILE, { lastRunTime });
}

// -------------------------
// 3️⃣ Schedule periodic check
// -------------------------
cron.schedule('*/5 * * * *', () => {  // every 5 minutes
  console.log('Running recent notes check...');
  fetchRecentNotes().catch(err => console.error('Error fetching notes:', err));
});

// -------------------------
// 4️⃣ Health check endpoint
// -------------------------
app.get('/', (req, res) => res.send('JobAdder Agreement Tracker Running!'));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
