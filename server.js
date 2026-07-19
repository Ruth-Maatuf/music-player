const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const unzipper = require('unzipper');
const app = express();
const port = process.env.PORT || 3001;

const musicDir = path.join(__dirname, 'music');
console.log("--- מבנה תיקיית music ---");
fs.readdirSync(musicDir).forEach(file => {
    console.log("נמצאה תיקייה/קובץ:", file);
});
// הגדרת אחסון
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(__dirname, 'music', req.body.eventCode || 'general');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        cb(null, file.originalname);
    }
});
const upload = multer({ storage });

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

// נתיב API מפורש לקריאת קבצי מוזיקה עם טיפול נכון בקידוד
app.get('/music/:eventCode/:folder/:genre/:filename', (req, res) => {
    try {
        const { eventCode, folder, genre, filename } = req.params;
        
        // תיקון קריטי: ניקוי שם הקובץ מה-Token במידה והוא צורף ל-URL
        const cleanFilename = filename.split('?')[0];

        const filePath = path.resolve(__dirname, 'music', eventCode, decodeURIComponent(folder), decodeURIComponent(genre), decodeURIComponent(cleanFilename));

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
    // קריאת תוכן התיקייה הנוכחית
    const list = fs.readdirSync(dir, { withFileTypes: true });

    list.forEach(item => {
        const fullPath = path.join(dir, item.name);
        if (item.isDirectory()) {
            // אם מצאנו תיקייה - קוראים לפונקציה שוב (רקורסיה)
            results = results.concat(getFilesRecursive(fullPath));
        } else if (item.name.toLowerCase().endsWith('.mp3') || item.name.toLowerCase().endsWith('.wav')) {
            // אם זה קובץ אודיו - מוסיפים לרשימה
            results.push(item.name);
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

app.post('/api/upload-song', upload.single('song'), async (req, res) => {
    const { eventCode } = req.body;
    if (!req.file) return res.status(400).json({ success: false, message: "לא נבחר קובץ" });

    const targetDir = path.join(__dirname, 'music', eventCode);

    try {
        // 1. חילוץ הקבצים מה-ZIP
        await fs.createReadStream(req.file.path)
            .pipe(unzipper.Extract({ path: targetDir }))
            .promise();

        // 2. ניקוי שמות הקבצים בתיקייה שחולצה
        sanitizeDirectory(targetDir);

        // 3. עדכון ה-JSON (כעת השמות נקיים)
        const updateJsonWithFiles = (dir, fileList = []) => {
            const files = fs.readdirSync(dir);
            files.forEach(file => {
                const fullPath = path.join(dir, file);
                if (fs.lstatSync(fullPath).isDirectory()) {
                    updateJsonWithFiles(fullPath, fileList);
                } else if (file.toLowerCase().endsWith('.mp3')) {
                    const relativePath = path.relative(path.join(__dirname, 'music'), fullPath);
                    fileList.push({ name: file, path: relativePath });
                }
            });
            return fileList;
        };

        const songsList = updateJsonWithFiles(targetDir);

        // 4. שמירה ב-events.json
        let events = JSON.parse(fs.readFileSync('events.json', 'utf8'));
        const event = events.find(e => e.code === eventCode);
        if (event) {
            event.songs = songsList;
            fs.writeFileSync('events.json', JSON.stringify(events, null, 2));
        }

        // 5. מחיקת קובץ ה-ZIP הזמני
        fs.unlinkSync(req.file.path);

        res.json({ success: true, message: "הקבצים חולצו, עברו ניקוי שמות, וה-JSON עודכן!" });

    } catch (err) {
        console.error("שגיאה בחילוץ ה-ZIP:", err);
        return res.status(500).json({ success: false, message: "שגיאה בתהליך העיבוד" });
    }
});

app.listen(port, () => console.log(`Server running on port ${port}`));