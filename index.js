// index.js

// 1. استدعاء المكتبات
require('dotenv').config();
const express = require('express');
const multer = require('multer');
const xlsx = require('xlsx');
const path = require('path');
const { Pool } = require('pg');
const { Parser } = require('json2csv');

// 2. إعداد Express App
const app = express();
const port = process.env.PORT || 8080;

app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// 3. إعداد Multer
const upload = multer({ storage: multer.memoryStorage() });

// 4. الاتصال بقاعدة البيانات (Supabase)
const db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
});

// دالة مساعدة لتحليل البيانات بأمان
const parseStudentData = (student) => ({
    ...student,
    data: typeof student.data === 'string' ? JSON.parse(student.data) : student.data,
});

// دالة مساعدة لحساب المتوسط
const calculateAverage = (arr) => {
    const validGrades = arr.filter(g => typeof g === 'number' && g > 0);
    if (validGrades.length === 0) return 0;
    const sum = validGrades.reduce((a, b) => a + b, 0);
    return sum / validGrades.length;
};

// دالة مساعدة لتوزيع المستويات
const calculateLevelDistribution = (allAverages) => {
    const distribution = { 'ممتاز (90%+)': 0, 'جيد جداً (80-90%)': 0, 'جيد (65-80%)': 0, 'مقبول (50-65%)': 0, 'يحتاج تحسين (<50%)': 0 };
    if (!allAverages || allAverages.length === 0) return distribution;
    allAverages.forEach(avg => {
        const percentage = (avg / 10) * 100;
        if (percentage >= 90) distribution['ممتاز (90%+)']++;
        else if (percentage >= 80) distribution['جيد جداً (80-90%)']++;
        else if (percentage >= 65) distribution['جيد (65-80%)']++;
        else if (percentage >= 50) distribution['مقبول (50-65%)']++;
        else distribution['يحتاج تحسين (<50%)']++;
    });
    return distribution;
};


// --- المسارات (Routes) ---

// الصفحة الرئيسية أو صفحة المسح
app.get('/', (req, res) => {
    res.render('scan');
});

// عرض صفحة الرفع
app.get('/upload', (req, res) => {
    res.render('upload', { error: null, success: null });
});

// معالجة رفع ملف الإكسل
app.post('/upload', upload.single('sheet'), async (req, res) => {
    if (req.body.password !== process.env.UPLOAD_PASSWORD) {
        return res.status(401).render('upload', { error: 'كلمة السر غير صحيحة!', success: null });
    }
    if (!req.file) {
        return res.status(400).render('upload', { error: 'الرجاء رفع ملف إكسل.', success: null });
    }

    const client = await db.connect();
    try {
        const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const data = xlsx.utils.sheet_to_json(sheet, { header: 1 });

        if (!data || data.length < 2) {
            return res.status(400).render('upload', { error: 'الملف فارغ أو لا يحتوي على صفوف بيانات.', success: null });
        }

        const headerRow = data[0];
        const studentRows = data.slice(1);

        const studentsToInsert = studentRows.map(row => {
            if (!row || row.length === 0) return null;
            const uniqueCodeIndex = headerRow.length - 1;
            const unique_code = row[uniqueCodeIndex];
            if (!unique_code || String(unique_code).trim() === '') return null;

            const studentData = { sessions: [], exams: {} };
            headerRow.forEach((header, index) => {
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
                unique_code: String(unique_code).trim(),
                data: JSON.stringify(studentData)
            };
        }).filter(s => s !== null);

        if (studentsToInsert.length === 0) {
            return res.render('upload', { error: 'لم يتم العثور على طلاب لديهم كود مميز في الملف.', success: null });
        }

        const insertQuery = `
          INSERT INTO students (student_id, student_name, unique_code, data)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (unique_code) 
          DO UPDATE SET
            student_id = EXCLUDED.student_id,
            student_name = EXCLUDED.student_name,
            data = EXCLUDED.data;
        `;

        await client.query('BEGIN');
        await Promise.all(studentsToInsert.map(student =>
            client.query(insertQuery, [student.student_id, student.student_name, student.unique_code, student.data])
        ));
        await client.query('COMMIT');

        res.render('upload', { success: `تم تحديث/إضافة بيانات ${studentsToInsert.length} طالب بنجاح!`, error: null });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error("!!! Critical Error during file processing:", error);
        res.status(500).render('upload', {
            error: 'حدث خطأ فادح أثناء معالجة الملف. تم التراجع عن جميع التغييرات.',
            success: null,
            debug: error.message,
        });
    } finally {
        client.release();
    }
});

// عرض معلومات طالب معين
app.get('/info/:code', async (req, res) => {
    try {
        const uniqueCode = req.params.code;
        const result = await db.query("SELECT * FROM students");
        
        const allStudents = result.rows.map(parseStudentData);

        const currentStudentRow = allStudents.find(r => r.unique_code === uniqueCode);
        if (!currentStudentRow) {
            return res.status(404).render('error', { message: 'هذا الكود غير صحيح أو الطالب غير موجود.' });
        }

        const currentStudent = {
            id: currentStudentRow.student_id,
            name: currentStudentRow.student_name,
            data: currentStudentRow.data
        };

        const stats = { session: { average: 0, rank: 0, classAverage: 0, rankPercentage: 0 }, exams: {} };
        const studentSessionGrades = currentStudent.data.sessions.map(s => s.grade);
        stats.session.average = calculateAverage(studentSessionGrades);
        const allSessionAverages = allStudents.map(s => calculateAverage(s.data.sessions.map(ses => ses.grade))).filter(avg => avg > 0).sort((a, b) => b - a);
        stats.session.rank = allSessionAverages.indexOf(stats.session.average) + 1;
        stats.session.classAverage = calculateAverage(allSessionAverages);
        if (allSessionAverages.length > 0) {
            stats.session.rankPercentage = (stats.session.rank / allSessionAverages.length) * 100;
        }

        Object.keys(currentStudent.data.exams).forEach(examName => {
            const studentExamGrade = currentStudent.data.exams[examName];
            const allExamGrades = allStudents.map(s => s.data.exams[examName]).filter(g => typeof g === 'number' && g > 0).sort((a, b) => b - a);
            const rank = allExamGrades.indexOf(studentExamGrade) + 1;
            stats.exams[examName] = {
                grade: studentExamGrade,
                rank: rank > 0 ? rank : 'N/A',
                classAverage: calculateAverage(allExamGrades).toFixed(1),
                totalStudents: allExamGrades.length,
                rankPercentage: rank > 0 ? (rank / allExamGrades.length) * 100 : 100,
            };
        });

        res.render('student-info', { student: currentStudent, data: currentStudent.data, stats: stats });
    } catch (error) {
        console.error("Error fetching student info:", error);
        res.status(500).render('error', { message: 'خطأ في جلب بيانات الطالب.' });
    }
});

// عرض صفحة تسجيل الدخول للداش بورد
app.get('/login', (req, res) => {
    res.render('dashboard-login', { error: null });
});

// معالجة تسجيل الدخول للداش بورد
app.post('/login', (req, res) => {
    if (req.body.password === process.env.UPLOAD_PASSWORD) {
        res.redirect('/dashboard');
    } else {
        res.render('dashboard-login', { error: 'كلمة السر غير صحيحة!' });
    }
});

// عرض الداش بورد الرئيسية
app.get('/dashboard', async (req, res) => {
    try {
        const result = await db.query("SELECT * FROM students");
        const studentsWithParsedData = result.rows.map(parseStudentData);
        const totalStudents = studentsWithParsedData.length;

        const examAverages = {};
        const examNames = new Set();
        studentsWithParsedData.forEach(student => {
            if (student.data && student.data.exams) {
                Object.keys(student.data.exams).forEach(examName => examNames.add(examName));
            }
        });

        examNames.forEach(examName => {
            const grades = studentsWithParsedData.map(s => s.data.exams[examName]).filter(g => typeof g === 'number' && g > 0);
            examAverages[examName] = calculateAverage(grades);
        });

        let totalSessionsCount = 0, totalAttendanceCount = 0;
        studentsWithParsedData.forEach(student => {
            if (student.data && student.data.sessions) {
                student.data.sessions.forEach(session => {
                    if (session.attendance) {
                        totalSessionsCount++;
                        if (session.attendance === 'حاضر') totalAttendanceCount++;
                    }
                });
            }
        });
        const overallAttendance = totalSessionsCount > 0 ? (totalAttendanceCount / totalSessionsCount) * 100 : 0;
        
        const allSessionAverages = studentsWithParsedData.map(s => calculateAverage(s.data.sessions.map(ses => ses.grade))).filter(avg => avg > 0);
        const levelDistribution = calculateLevelDistribution(allSessionAverages);
        
        res.render('dashboard', {
            totalStudents,
            examAverages,
            overallAttendance: overallAttendance.toFixed(1),
            levelDistribution
        });
    } catch (error) {
        console.error("Error loading dashboard:", error);
        res.status(500).render('error', { message: 'خطأ في تحميل بيانات الداش بورد.' });
    }
});

// عرض تفاصيل امتحان معين
app.get('/exam/:examName', async (req, res) => {
    try {
        const examName = decodeURIComponent(req.params.examName);
        const result = await db.query("SELECT student_name, unique_code, data FROM students");
        const studentsWithGrade = result.rows.map(parseStudentData).map(row => {
            if (row.data.exams && typeof row.data.exams[examName] !== 'undefined' && row.data.exams[examName] !== null) {
                return { name: row.student_name, unique_code: row.unique_code, grade: row.data.exams[examName] };
            }
            return null;
        }).filter(Boolean).sort((a, b) => b.grade - a.grade);
        res.render('exam-details', { examName, students: studentsWithGrade });
    } catch(error) {
        console.error(`Error fetching details for exam ${req.params.examName}:`, error);
        res.status(500).render('error', { message: 'خطأ في جلب تفاصيل الامتحان.' });
    }
});

// تصدير البيانات كملف CSV
app.get('/export/csv', async (req, res) => {
    try {
        const result = await db.query("SELECT student_id, student_name, data FROM students");
        const flatData = result.rows.map(parseStudentData).map(row => {
            const baseInfo = { 'ID': row.student_id, 'Name': row.student_name };
            if (row.data.sessions) {
                row.data.sessions.forEach((session, i) => {
                    baseInfo[`Session ${i+1} Grade`] = session.grade;
                    baseInfo[`Session ${i+1} Attendance`] = session.attendance;
                });
            }
            if (row.data.exams) {
                Object.keys(row.data.exams).forEach(examName => {
                    baseInfo[examName] = row.data.exams[examName];
                });
            }
            return baseInfo;
        });

        if (flatData.length === 0) return res.status(404).send("لا توجد بيانات لتصديرها.");

        const csv = new Parser().parse(flatData);
        res.header('Content-Type', 'text/csv; charset=utf-8');
        res.attachment('student_grades_export.csv');
        res.send(csv);
    } catch(error) {
        console.error("Error exporting CSV:", error);
        res.status(500).send("لا يمكن تصدير البيانات حاليًا.");
    }
});


// 5. تشغيل الخادم
app.listen(port, () => {
    console.log(`Server is running at http://localhost:${port}`);
});
