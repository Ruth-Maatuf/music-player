const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');


const app = express();
const PORT = 3001;

app.use(cors({
  origin: '*', // מאפשר לכל אתר לפנות, זה יפתור את השגיאה בוודאות
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json());

const activeEvents = {
  "wedding2026": {
    id: "event-123",
    folderName: "wedding2026",
    //expirationTime: new Date(Date.now() + 2 * 60 * 60 * 1000)
  }
};

const activeTokens = new Map();

// 1. אימות + סריקת ז'אנרים ותתי-תיקיות
app.post('/api/verify-event', (req, res) => {
  const { code } = req.body;
  const event = activeEvents[code];

  if (!event) {
    return res.status(401).json({ success: false, message: "קוד אירוע שגוי!" });
  }

  const now = new Date();
  if (now > event.expirationTime) {
    return res.status(403).json({ success: false, message: "פג תוקף הגישה לאירוע זה!" });
  }

  const eventFolderPath = path.join(__dirname, 'music', event.folderName);

  if (!fs.existsSync(eventFolderPath)) {
    return res.status(404).json({ success: false, message: "תיקיית האירוע לא קיימת בשרת" });
  }

  try {
    const items = fs.readdirSync(eventFolderPath);
    const playlistStructure = {};

    // רצים על כל הפריטים בתיקיית האירוע ובודקים אם הם תיקיות (ז'אנרים)
    items.forEach(item => {
      const itemPath = path.join(eventFolderPath, item);
      const isDirectory = fs.lstatSync(itemPath).isDirectory();

      if (isDirectory) {
        // אם זו תיקייה, סורקים את קבצי ה-MP3 שבתוכה
        const files = fs.readdirSync(itemPath);
        const mp3Files = files.filter(file => file.endsWith('.mp3'));
        
        if (mp3Files.length > 0) {
          playlistStructure[item] = mp3Files; // שומרים: "שם_התיקייה": [שיר1, שיר2...]
        }
      }
    });

    // גיבוי: אם אין תתי-תיקיות, נחפש שירים ישירות בתיקייה הראשית
    if (Object.keys(playlistStructure).length === 0) {
      const directFiles = items.filter(file => file.endsWith('.mp3'));
      if (directFiles.length > 0) {
        playlistStructure["כללי"] = directFiles;
      } else {
        return res.status(404).json({ success: false, message: "לא נמצאו שירים או ז'אנרים בתיקיית האירוע" });
      }
    }

    const streamToken = crypto.randomBytes(16).toString('hex');
    const tokenExpiry = Date.now() + 15 * 60 * 1000; // 15 דקות
    activeTokens.set(streamToken, { expiry: tokenExpiry, eventKey: code });

    res.json({ 
      success: true, 
      message: "הגישה אושרה!", 
      eventId: event.id,
      streamToken: streamToken,
      playlist: playlistStructure // מחזיר אובייקט של { "שקט": [...], "קצבי": [...] }
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "שגיאה בסריקת התיקיות מהשרת" });
  }
});

// 2. הזרמת שיר מתוך תיקיית ז'אנר ספציפית
app.get('/api/stream', (req, res) => {
  const { token, track, genre } = req.query;

  if (!token || !activeTokens.has(token)) {
    return res.status(403).send("גישה חסומה: טוקן פג תוקף");
  }

  const tokenData = activeTokens.get(token);
  if (Date.now() > tokenData.expiry) {
    activeTokens.delete(token);
    return res.status(403).send("גישה חסומה: פג תוקף החיבור");
  }

  if (!track) {
    return res.status(400).send("לא נבחר שיר");
  }

  const event = activeEvents[tokenData.eventKey];
  
  // בניית נתיב: music/[שם האירוע]/[הז'אנר (אם קיים)]/[שם השיר]
// 1. נגדיר את תיקיית הבסיס בצורה מוחלטת
  const rootMusicDir = path.join(__dirname, 'music', event.folderName);

  // 2. נשתמש ב-path.normalize כדי לנקות ../ ונוודא שהקובץ מתחיל בתיקיית הבסיס
  const requestedPath = genre && genre !== "undefined"
    ? path.join(rootMusicDir, genre, track)
    : path.join(rootMusicDir, track);

  const normalizedPath = path.normalize(requestedPath);

  // 3. הגנה: אם הנתיב לא מתחיל בתיקיית האירוע - עצור!
  if (!normalizedPath.startsWith(rootMusicDir)) {
    return res.status(403).send("גישה לא מורשית!");
  }

  const musicPath = normalizedPath;

  if (!fs.existsSync(musicPath)) {
    return res.status(404).send("השיר לא נמצא בשרת");
  }

  const stat = fs.statSync(musicPath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunksize = (end - start) + 1;
    const file = fs.createReadStream(musicPath, { start, end });
    const head = {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': 'audio/mpeg',
    };
    res.writeHead(206, head);
    file.pipe(res);
  } else {
    const head = {
      'Content-Length': fileSize,
      'Content-Type': 'audio/mpeg',
    };
    res.writeHead(200, head);
    fs.createReadStream(musicPath).pipe(res);
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});