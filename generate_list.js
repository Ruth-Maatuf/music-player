const fs = require('fs');
const path = require('path');

const musicDir = path.join(__dirname, 'music'); // ודאי שזה השם של התיקייה אצלך
const songs = {};

function scanDir(dir, genre) {
    const items = fs.readdirSync(dir);
    items.forEach(item => {
        const fullPath = path.join(dir, item);
        if (fs.lstatSync(fullPath).isDirectory()) {
            scanDir(fullPath, item);
        } else if (item.endsWith('.mp3')) {
            if (!songs[genre || 'כללי']) songs[genre || 'כללי'] = [];
            songs[genre || 'כללי'].push({ title: item, fileName: item });
        }
    });
}

scanDir(musicDir);
fs.writeFileSync('songs.json', JSON.stringify(songs, null, 2));
console.log('נוצר קובץ songs.json בהצלחה!');