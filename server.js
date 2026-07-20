const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const unzipper = require('unzipper');
const app = express();
require('dotenv').config();
const cloudinary = require('cloudinary').v2;


const port = process.env.PORT || 3001;

const memoryStorage = multer.memoryStorage();

// הגדרה ידנית של המשתנים לניסוי
cloudinary.config({
    cloud_name: 'khsnvhkw',
    api_key: '331654641892112',
    api_secret: 'P7_iMB0lSWc8JRDEZ94ncYMqw2o'
});

// עדכון הבדיקה
console.log("Cloudinary Config Check: תקין");




console.log("Cloudinary Config Check:", !!process.env.API_KEY);
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'] }));
app.use(express.json());


app.use('/music', (req, res, next) => {
    console.log("--- בקשת שמע ---");
    console.log("הנתיב המבוקש מהנגן:", req.url);
    const fullPath = path.join(__dirname, 'music', req.path);
    console.log("הנתיב המלא בשרת:", fullPath);
    console.log("האם הקובץ קיים פיזית?", fs.existsSync(fullPath));
    console.log("הנגן מנסה לגשת ל:", decodeURIComponent(req.path));
    next();

});

const upload = multer({ storage: memoryStorage });

// נתיב API מפורש לקריאת קבצי מוזיקה עם טיפול נכון בקידוד
app.get('/music/:eventCode/:folder/:genre/:filename', (req, res) => {
    try {
        const { eventCode, folder, genre, filename } = req.params;

        // 1. ניקוי שם הקובץ מה-Token במידה והוא צורף ל-URL
        const cleanFilename = filename.split('?')[0];

        // 2. פענוח כל חלק בנתיב כדי לתמוך בעברית ובתווים מיוחדים
        const decodedFolder = decodeURIComponent(folder);
        const decodedGenre = decodeURIComponent(genre);
        const decodedFilename = decodeURIComponent(cleanFilename);

        // 3. בניית הנתיב המלא באמצעות החלקים המפוענחים
        const filePath = path.resolve(__dirname, 'music', eventCode, decodedFolder, decodedGenre, decodedFilename);

        // 4. בדיקת קיום הקובץ
        if (!fs.existsSync(filePath)) {
            console.error("❌ הקובץ לא נמצא בנתיב:", filePath);
            return res.status(404).send('File not found');
        }

        const stat = fs.statSync(filePath);
        const fileSize = stat.size;
        const range = req.headers.range;

        if (range) {
            const parts = range.replace(/bytes=/, "").split("-");
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

            if (start >= fileSize || (end !== undefined && end >= fileSize)) {
                res.writeHead(416, { 'Content-Range': `bytes */${fileSize}` });
                return res.end();
            }

            const chunksize = (end - start) + 1;
            res.writeHead(206, {
                'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': chunksize,
                'Content-Type': 'audio/mpeg',
            });
            fs.createReadStream(filePath, { start, end }).pipe(res);
        } else {
            res.writeHead(200, {
                'Content-Length': fileSize,
                'Content-Type': 'audio/mpeg',
                'Accept-Ranges': 'bytes'
            });
            fs.createReadStream(filePath).pipe(res);
        }
    } catch (err) {
        console.error("שגיאה בהגשת הקובץ:", err);
        res.status(500).send('Internal Server Error');
    }
});

let activeEvents = {};
const activeTokens = new Map();

// טעינת אירועים
const loadEventsFromDisk = () => {
    const filePath = path.join(__dirname, 'events.json');
    if (fs.existsSync(filePath)) {
        try {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf8') || '[]');
            activeEvents = {};
            data.forEach(ev => {
                activeEvents[ev.code] = { id: ev.code, folderName: ev.code, expirationTime: new Date(ev.expiryDate) };
            });
            console.log("✅ אירועים נטענו:", Object.keys(activeEvents));
        } catch (e) { console.error("❌ שגיאה:", e); }
    }
};
loadEventsFromDisk();

const getFilesRecursive = (dir) => {
    let results = [];
    const list = fs.readdirSync(dir, { withFileTypes: true });

    list.forEach(item => {
        const fullPath = path.join(dir, item.name);
        if (item.isDirectory()) {
            results = results.concat(getFilesRecursive(fullPath));
        } else if (item.name.toLowerCase().endsWith('.mp3') || item.name.toLowerCase().endsWith('.wav')) {
            // החזרה כאובייקט עם name ו-path
            results.push({
                name: item.name,
                path: `https://res.cloudinary.com/khsnvhkw/video/upload/music/test4/${path.basename(path.dirname(fullPath))}/${item.name}`
            });
        }
    });
    return results;
};

//אימות
app.post('/api/verify-event', (req, res) => {
    const { code } = req.body;
    const event = activeEvents[code];
    if (!event) return res.status(401).json({ success: false, message: "קוד אירוע שגוי!" });
    if (new Date() > new Date(event.expirationTime)) return res.status(403).json({ success: false, message: "פג תוקף!" });

    const eventFolderPath = path.join(__dirname, 'music', event.folderName);
    if (!fs.existsSync(eventFolderPath)) fs.mkdirSync(eventFolderPath, { recursive: true });

    const playlist = {};
    console.log("נתיב האירוע שנסרק:", eventFolderPath);
    const exists = fs.existsSync(eventFolderPath);
    console.log("האם התיקייה קיימת?", exists);

    // 1. סריקת תיקיות המעטפת (למשל 'AA')
    const subfolders = fs.readdirSync(eventFolderPath, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory());

    subfolders.forEach(aaFolder => {
        const aaPath = path.join(eventFolderPath, aaFolder.name);

        // 2. סריקת הז'אנרים שנמצאים בתוך תיקיית המעטפת
        const genreFolders = fs.readdirSync(aaPath, { withFileTypes: true })
            .filter(dirent => dirent.isDirectory());

        genreFolders.forEach(genre => {
            const genrePath = path.join(aaPath, genre.name);
            // מילוי הפלייליסט לפי שם הז'אנר האמיתי
            playlist[genre.name] = getFilesRecursive(genrePath);
            console.log(`נמצאו ${playlist[genre.name].length} קבצים בז'אנר ${genre.name}`);
        });
    });

    const streamToken = crypto.randomBytes(16).toString('hex');
    activeTokens.set(streamToken, { expiry: Date.now() + 15 * 60 * 1000, eventKey: code });

    res.json({ success: true, streamToken, playlist });
});

// יצירת אירוע
app.post('/api/admin/create-event', (req, res) => {
    const { code, expiryDate } = req.body;
    let events = fs.existsSync('events.json') ? JSON.parse(fs.readFileSync('events.json', 'utf8') || '[]') : [];
    events.push({ code, expiryDate, songs: [] });
    fs.writeFileSync('events.json', JSON.stringify(events, null, 2));
    activeEvents[code] = { id: code, folderName: code, expirationTime: new Date(expiryDate) };
    res.json({ success: true, message: 'האירוע נוצר!' });
});

// פונקציית עזר לניקוי שם הקובץ
const sanitizeFileName = (fileName) => {
    const ext = path.extname(fileName);
    const baseName = path.basename(fileName, ext);
    // החלפת כל תו שאינו אות, מספר, מקף או קו תחתון בקו תחתון
    const cleanBase = baseName.replace(/[^a-zA-Z0-9\u0590-\u05FF_\-]/g, '_');
    return cleanBase + ext;
};

// פונקציה רקורסיבית לניקוי שמות קבצים בתיקייה
const sanitizeDirectory = (dir) => {
    const items = fs.readdirSync(dir);
    items.forEach(item => {
        const oldPath = path.join(dir, item);
        const stats = fs.statSync(oldPath);

        if (stats.isDirectory()) {
            sanitizeDirectory(oldPath);
        } else if (item.toLowerCase().endsWith('.mp3')) {
            const newName = sanitizeFileName(item);
            const newPath = path.join(dir, newName);
            if (oldPath !== newPath) {
                fs.renameSync(oldPath, newPath);
            }
        }
    });
};

// יש לוודא התקנה: npm install adm-zip
const AdmZip = require('adm-zip');


app.post('/api/upload-song', upload.single('song'), async (req, res) => {
    const { eventCode } = req.body;
    console.log("[Server] Files:", req.file);
    console.log("[Server] Body:", req.body);

    if (!req.file || !req.file.buffer) {
        console.error("[Server] ❌ הקובץ לא נמצא בזיכרון.");
        return res.status(400).json({ success: false, message: "שגיאת העלאה: הקובץ לא נקלט" });
    }

    console.log(`[Server] 🚀 עיבוד אירוע: ${eventCode} | גודל בזיכרון: ${req.file.buffer.length} bytes`);

    try {
        const zip = new AdmZip(req.file.buffer);
        const zipEntries = zip.getEntries();

        console.log(`[Server] 🔍 נמצאו ${zipEntries.length} פריטים ב-ZIP.`);

        if (zipEntries.length === 0) {
            return res.status(400).json({ success: false, message: "ה-ZIP ריק או לא תקין" });
        }

        const songsList = [];

        for (const entry of zipEntries) {
            console.log("[DEBUG] Found entry:", entry.entryName);

            if (entry.entryName.includes('__MACOSX')) continue;

            // בדיקה האם הקובץ הוא MP3 (לא משנה אם הוא בתיקייה או לא)
            if (entry.entryName.toLowerCase().endsWith('.mp3') && !entry.isDirectory) {

                // כאן אנחנו מחלצים את שם התיקייה האחרונה כז'אנר
                const parts = entry.entryName.split('/').filter(p => p.length > 0);
                const genre = parts.length > 1 ? parts[parts.length - 2] : "General";
                const songName = path.basename(entry.entryName, '.mp3');

                console.log(`[DEBUG] Processing: ${songName} | Genre: ${genre}`);

                try {
                    const result = await new Promise((resolve, reject) => {
                        const stream = cloudinary.uploader.upload_stream(
                            {
                                resource_type: "video",
                                folder: `music/${eventCode}/${genre}`,
                                public_id: songName
                            },
                            (error, res) => error ? reject(error) : resolve(res)
                        );
                        stream.end(entry.getData());
                    });
                    songsList.push({ name: songName, genre, path: result.secure_url });
                } catch (uploadErr) {
                    console.error(`[Server] שגיאת העלאה ב-${songName}:`, uploadErr);
                }
            }
        }

        // ... (אחרי סיום הלולאה ואיסוף השירים לתוך songsList) ...

        if (songsList.length === 0) {
            return res.status(400).json({ success: false, message: "לא נמצאו קבצי MP3 תקינים ב-ZIP" });
        }

        // טעינה מחדש של הקובץ לפני כתיבה כדי לוודא שאין התנגשויות
        let events = [];
        if (fs.existsSync('events.json')) {
            events = JSON.parse(fs.readFileSync('events.json', 'utf8'));
        }

        const eventIndex = events.findIndex(e => e.code === eventCode);

        if (eventIndex !== -1) {
            // הוספת השירים שנקלטו מהענן לרשימה
            events[eventIndex].songs = songsList;

            // כתיבה מסודרת לקובץ
            fs.writeFileSync('events.json', JSON.stringify(events, null, 2));
            console.log(`[Server] עודכן קובץ events.json עם ${songsList.length} שירים עבור ${eventCode}`);

            res.json({ success: true, message: `הועלו ${songsList.length} שירים!`, urls: songsList });
        } else {
            res.status(404).json({ success: false, message: "קוד אירוע לא נמצא" });
        }

    } catch (err) {
        console.error("[Server] 💥 שגיאה בעיבוד ה-ZIP:", err);
        res.status(500).json({ success: false, message: "שגיאה פנימית בעיבוד הקובץ" });
    }
});
app.listen(port, () => console.log(`Server running on port ${port}`));