// index.js

// 1. استدعاء المكتبات
require('dotenv').config(); // لتحميل المتغيرات من ملف .env
const express = require('express');
const multer = require('multer');
const xlsx = require('xlsx');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// 2. إعداد Express App
const app = express();
const port = 8080 || process.env.PORT;

app.set('views', path.join(__dirname, 'views'));

app.set('view engine', 'ejs'); // تحديد EJS كمحرك قوالب
app.use(express.urlencoded({ extended: true })); // لقراءة البيانات من الفورم
app.use(express.static(path.join(__dirname, 'public'))); // لخدمة الملفات الثابتة

// 3. إعداد Multer لتخزين الملف المرفوع في الذاكرة مؤقتاً
const upload = multer({ storage: multer.memoryStorage() });

// 4. الاتصال بقاعدة البيانات (أو إنشائها إذا لم تكن موجودة)
const db = new sqlite3.Database('./database.db', sqlite3.OPEN_READONLY, (err) => {
    if (err) {
        console.error("Error opening database " + err.message);
    } else {
        console.log("Database connected!");
        // إنشاء الجدول عند بدء تشغيل الخادم إذا لم يكن موجودًا
        db.run(`
            CREATE TABLE IF NOT EXISTS students (
                student_id TEXT,
                student_name TEXT,
                unique_code TEXT PRIMARY KEY,
                data TEXT
            )
        `);
    }
});
/*
// Route لعرض صفحة الرفع
app.get('/upload', (req, res) => {
    res.render('upload');
});

// server.js - (استبدل الدالة القديمة بهذه النسخة المصححة)

app.post('/upload', upload.single('sheet'), (req, res) => {
    const { password } = req.body;

    if (password !== process.env.UPLOAD_PASSWORD) {
        return res.status(401).render('upload', { error: 'كلمة السر غير صحيحة!' });
    }
    if (!req.file) {
        return res.status(400).render('upload', { error: 'الرجاء رفع ملف إكسل.' });
    }

    try {
        const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const data = xlsx.utils.sheet_to_json(sheet, { header: 1 });

        // التحقق من وجود بيانات ورأس جدول
        if (!data || data.length < 2) {
            return res.render('upload', { error: 'الملف فارغ أو لا يحتوي على صفوف بيانات.' });
        }

        const headerRow = data[0];
        const studentRows = data.slice(1);

        const studentsToInsert = studentRows.map(row => {
            // تجاهل الصفوف الفارغة تماماً
            if (row.length === 0) return null;

            const studentData = { sessions: [], exams: {} };
            const uniqueCodeIndex = headerRow.length - 1;
            const unique_code = row[uniqueCodeIndex];

            if (!unique_code) return null; // تجاهل أي صف بدون كود مميز

            headerRow.forEach((header, index) => {
                // التأكد من أن الـ header ليس فارغاً قبل استخدامه
                if (header) { 
                    const value = row[index] !== undefined ? row[index] : null;

                    if (header.includes("درجة امتحان حصة")) {
                        const match = header.match(/\d+/);
                        if (match) {
                            const sessionNumber = parseInt(match[0], 10);
                            while (studentData.sessions.length < sessionNumber) studentData.sessions.push({ grade: null, attendance: null });
                            studentData.sessions[sessionNumber - 1].grade = value;
                        }
                    } else if (header.includes("حضور حصة")) {
                        const match = header.match(/\d+/);
                        if (match) {
                            const sessionNumber = parseInt(match[0], 10);
                            while (studentData.sessions.length < sessionNumber) studentData.sessions.push({ grade: null, attendance: null });
                            studentData.sessions[sessionNumber - 1].attendance = value;
                        }
                    } else if (header.includes("امتحان") || header.includes("مراجعة")) {
                        studentData.exams[header] = value;
                    }
                }
            });

            return {
                student_id: row[0],
                student_name: row[1],
                unique_code: unique_code,
                data: JSON.stringify(studentData)
            };
        }).filter(s => s !== null);

        if (studentsToInsert.length === 0) {
            return res.render('upload', { error: 'لم يتم العثور على طلاب لديهم كود مميز في الملف.' });
        }

        db.serialize(() => {
            db.run("DELETE FROM students", err => { if (err) throw err; });
            const stmt = db.prepare("INSERT INTO students (student_id, student_name, unique_code, data) VALUES (?, ?, ?, ?)");
            studentsToInsert.forEach(student => {
                stmt.run(student.student_id, student.student_name, student.unique_code, student.data);
            });
            stmt.finalize(err => {
                if (err) throw err;
                console.log(`${studentsToInsert.length} students inserted successfully.`);
                res.render('upload', { success: `تم رفع ومعالجة بيانات ${studentsToInsert.length} طالب بنجاح!` });
            });
        });

    } catch (error) {
        // هذا هو الجزء الأهم الآن! سيطبع الخطأ الفعلي في الـ terminal
        console.error("!!! Critical Error during file processing:", error);
        res.status(500).render('upload', { error: 'حدث خطأ أثناء معالجة الملف. تأكد من أن صيغة الملف صحيحة.' });
    }
});
*/
// Route جديد لعرض صفحة المسح
app.get('/info', (req, res) => {
    // هذا المسار يعرض الصفحة التي تحتوي على كاميرا المسح
    res.render('scan'); 
});

// دالة مساعدة لتجاهل الدرجات الصفرية في الحسابات
const calculateAverage = (arr) => {
    const validGrades = arr.filter(g => g !== null && g > 0);
    if (validGrades.length === 0) return 0;
    const sum = validGrades.reduce((a, b) => a + b, 0);
    return (sum / validGrades.length);
};

app.get('/info/:code', (req, res) => {
    const uniqueCode = req.params.code;

    // 1. جلب بيانات كل الطلاب مرة واحدة لتحليلها
    db.all("SELECT * FROM students", [], (err, allRows) => {
        if (err) {
            console.error(err);
            return res.status(500).render('error', { message: 'خطأ في جلب بيانات الطلاب.' });
        }

        // 2. البحث عن الطالب الحالي
        const currentRow = allRows.find(r => r.unique_code === uniqueCode);
        if (!currentRow) {
            return res.status(404).render('error', { message: 'هذا الكود غير صحيح أو الطالب غير موجود.' });
        }

        const currentStudent = {
            id: currentRow.student_id,
            name: currentRow.student_name,
            data: JSON.parse(currentRow.data)
        };

        // 3. تحليل بيانات كل الطلاب لحساب الإحصائيات
        const allStudentsData = allRows.map(r => ({ ...JSON.parse(r.data), student_id: r.student_id }));
        const stats = {
            session: { average: 0, rank: 0, classAverage: 0, rankPercentage: 0 },
            exams: {}
        };

        // --- حساب إحصائيات الحصص ---
        const studentSessionGrades = currentStudent.data.sessions.map(s => s.grade);
        stats.session.average = calculateAverage(studentSessionGrades);

        const allSessionAverages = allStudentsData
            .map(s => calculateAverage(s.sessions.map(ses => ses.grade)))
            .filter(avg => avg > 0) // تجاهل الطلاب اللي متوسطهم صفر
            .sort((a, b) => b - a); // ترتيب تنازلي

        stats.session.rank = allSessionAverages.indexOf(stats.session.average) + 1;
        stats.session.classAverage = calculateAverage(allSessionAverages);
        if(allSessionAverages.length > 0) {
            stats.session.rankPercentage = (stats.session.rank / allSessionAverages.length) * 100;
        }


        // --- حساب إحصائيات الامتحانات الكبرى ---
        Object.keys(currentStudent.data.exams).forEach(examName => {
            const studentExamGrade = currentStudent.data.exams[examName];

            const allExamGrades = allStudentsData
                .map(s => s.exams[examName])
                .filter(g => g !== null && g > 0) // تجاهل الغياب
                .sort((a, b) => b - a); // ترتيب تنازلي

            const rank = allExamGrades.indexOf(studentExamGrade) + 1;
            const classAverage = calculateAverage(allExamGrades);
            const rankPercentage = (rank / allExamGrades.length) * 100;


            stats.exams[examName] = {
                grade: studentExamGrade,
                rank: rank > 0 ? rank : 'N/A', // لا ترتيب لو الطالب غائب
                classAverage: classAverage.toFixed(1),
                totalStudents: allExamGrades.length,
                rankPercentage: rank > 0 ? rankPercentage : 100
            };
        });

        // 4. إرسال كل البيانات المعالجة إلى الواجهة
        res.render('student-info', {
            student: { student_id: currentStudent.id, student_name: currentStudent.name },
            data: currentStudent.data,
            stats: stats // <-- هنا نرسل الإحصائيات الجديدة
        });
    });
});
// دالة مساعدة لحساب توزيع الطلاب
const calculateLevelDistribution = (allAverages) => {
    const distribution = { 'ممتاز (90%+)': 0, 'جيد جداً (80-90%)': 0, 'جيد (65-80%)': 0, 'مقبول (50-65%)': 0, 'يحتاج تحسين (<50%)': 0 };
    const totalStudents = allAverages.length;
    if (totalStudents === 0) return distribution;

    allAverages.forEach(avg => {
        // افترض أن الدرجة من 10 للحصص، ومن 100 للامتحانات الكبرى. سنوحدها كنسبة مئوية.
        // هذا الجزء يحتاج لتعديل حسب الدرجة النهائية لكل امتحان. سنفترض أن متوسط الحصص من 10.
        const percentage = (avg / 10) * 100; // مثال لدرجة الحصص
        if (percentage >= 90) distribution['ممتاز (90%+)']++;
        else if (percentage >= 80) distribution['جيد جداً (80-90%)']++;
        else if (percentage >= 65) distribution['جيد (65-80%)']++;
        else if (percentage >= 50) distribution['مقبول (50-65%)']++;
        else distribution['يحتاج تحسين (<50%)']++;
    });
    return distribution;
};


app.get('/dashboard', (req, res) => {
    // يمكنك إضافة حماية بكلمة سر هنا بنفس طريقة صفحة الرفع
    db.all("SELECT * FROM students", [], (err, allRows) => {
        if (err) {
            console.error(err);
            return res.status(500).render('error', { message: 'خطأ في جلب بيانات الطلاب.' });
        }

        const allStudentsData = allRows.map(r => JSON.parse(r.data));
        const totalStudents = allStudentsData.length;

        // 1. متوسط درجات كل امتحان كبير
        const examAverages = {};
        const examNames = allStudentsData.length > 0 ? Object.keys(allStudentsData[0].exams) : [];
        examNames.forEach(examName => {
            const grades = allStudentsData.map(s => s.exams[examName]).filter(g => g !== null && g > 0);
            examAverages[examName] = calculateAverage(grades);
        });
        
        // 2. نسبة الحضور الإجمالية
        let totalSessionsCount = 0;
        let totalAttendanceCount = 0;
        allStudentsData.forEach(student => {
            student.sessions.forEach(session => {
                if (session.attendance) { // تأكد من وجود سجل للحضور
                    totalSessionsCount++;
                    if (session.attendance === 'حاضر') {
                        totalAttendanceCount++;
                    }
                }
            });
        });
        const overallAttendance = totalSessionsCount > 0 ? (totalAttendanceCount / totalSessionsCount) * 100 : 0;

        // 3. توزيع الطلاب حسب المستوى (بناء على متوسط الحصص)
        const allSessionAverages = allStudentsData
            .map(s => calculateAverage(s.sessions.map(ses => ses.grade)))
            .filter(avg => avg > 0);
        const levelDistribution = calculateLevelDistribution(allSessionAverages);


        res.render('dashboard', {
            totalStudents: totalStudents,
            examAverages: examAverages,
            overallAttendance: overallAttendance.toFixed(1),
            levelDistribution: levelDistribution,
            allStudentsRawData: allRows // لإتاحة التصدير
        });
    });
});
const { Parser } = require('json2csv');



app.get('/export/csv', (req, res) => {
    db.all("SELECT student_id, student_name, data FROM students", [], (err, rows) => {
        if (err) {
            return res.status(500).send("Could not export data.");
        }

        const flatData = [];
        rows.forEach(row => {
            const parsedData = JSON.parse(row.data);
            const baseInfo = {
                'ID': row.student_id,
                'Name': row.student_name,
            };
            
            // إضافة درجات الحصص
            parsedData.sessions.forEach((session, i) => {
                baseInfo[`Session ${i+1} Grade`] = session.grade;
                baseInfo[`Session ${i+1} Attendance`] = session.attendance;
            });

            // إضافة درجات الامتحانات
            Object.keys(parsedData.exams).forEach(examName => {
                baseInfo[examName] = parsedData.exams[examName];
            });
            
            flatData.push(baseInfo);
        });

        const json2csvParser = new Parser();
        const csv = json2csvParser.parse(flatData);

        res.header('Content-Type', 'text/csv');
        res.attachment('student_grades_export.csv');
        res.send(csv);
    });
});
// 5. تشغيل الخادم
app.listen(port, () => {
    console.log(`Server is running at http://localhost:${port}`);
});

