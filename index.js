// index.js

// --- 1. استدعاء المكتبات ---
const cookieParser = require('cookie-parser');
require('dotenv').config();
const express = require('express');
const multer = require('multer');
const xlsx = require('xlsx');
const path = require('path');
const { Pool } = require('pg');
const { Parser } = require('json2csv');
const { v4: uuidv4 } = require('uuid');
const speakeasy = require('speakeasy');
const qrcode = require('qrcode');

// --- 2. إعداد Express App ---
const app = express();
const port = process.env.PORT || 8080;

app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

// Middlewares الأساسية
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(cookieParser()); // <-- تفعيل مكتبة الكوكيز

// --- 3. إعداد Multer ---
const upload = multer({ storage: multer.memoryStorage() });
const backupUpload = multer({ storage: multer.memoryStorage() }); // للنسخ الاحتياطي

// --- 4. الاتصال بقاعدة البيانات (Supabase) ---
const db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
});

// --- 5. نظام المصادقة وتسجيل الدخول (Authentication) ---

// مخزن بسيط لتخزين معرفات الجلسات النشطة في الذاكرة
const activeSessions = new Set();
const AUTH_COOKIE_NAME = 'session_token';

/**
 * Middleware للتحقق من وجود جلسة دخول صالحة.
 * إذا لم تكن هناك جلسة، يتم إعادة توجيه المستخدم إلى صفحة تسجيل الدخول.
 */
const requireAuth = (req, res, next) => {
    const token = req.cookies[AUTH_COOKIE_NAME];
    if (token && activeSessions.has(token)) {
        // المستخدم مسجل دخوله والجلسة صالحة، اسمح له بالمرور
        return next();
    } else {
        // لا يوجد كوكي أو الكوكي غير صالح، أعد توجيهه لصفحة الدخول
        res.redirect('/login');
    }
};

// --- 6. الدوال المساعدة (Helper Functions) ---
// --- EXISTING HELPER FUNCTIONS ---
const parseStudentData = (student) => ({
    ...student,
    data: typeof student.data === 'string' ? JSON.parse(student.data) : student.data,
});
const calculateAverage = (arr) => {
    // هذه الدالة سليمة، المشكلة في البيانات التي تُمرر لها
    const validGrades = arr.filter(g => typeof g === 'number' && g > 0 && isFinite(g));
    if (validGrades.length === 0) return 0;
    const sum = validGrades.reduce((a, b) => a + b, 0);
    return sum / validGrades.length;
};
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

// --- 7. الصفحات العامة (لا تتطلب تسجيل دخول) ---

// الصفحة الرئيسية أو صفحة المسح للطالب
app.get('/', (req, res) => {
    res.render('scan');
});

// عرض صفحة تسجيل الدخول للوحة التحكم
app.get('/login', (req, res) => {
    res.render('dashboard-login', { error: null });
});

// معالجة طلب تسجيل الدخول
app.post('/login', (req, res) => {
    if (req.body.password === process.env.UPLOAD_PASSWORD) {
        // كلمة المرور صحيحة
        const sessionToken = uuidv4(); // إنشاء معرف جلسة فريد
        activeSessions.add(sessionToken); // إضافة المعرف للجلسات النشطة

        // إعداد الكوكي في متصفح المستخدم
        res.cookie(AUTH_COOKIE_NAME, sessionToken, {
            httpOnly: true, // لمنع الوصول إليها من خلال JavaScript في المتصفح (أكثر أمانًا)
            secure: process.env.NODE_ENV === 'production', // استخدم https فقط في بيئة الإنتاج
            maxAge: 24 * 60 * 60 * 1000 // مدة صلاحية الكوكي (24 ساعة)
        });

        res.redirect('/dashboard'); // توجيه المستخدم إلى الداش بورد
    } else {
        // كلمة المرور خاطئة
        res.render('dashboard-login', { error: 'كلمة السر غير صحيحة!' });
    }
});

// تسجيل الخروج
app.get('/logout', (req, res) => {
    const token = req.cookies[AUTH_COOKIE_NAME];
    if (token) {
        activeSessions.delete(token); // حذف الجلسة من المخزن
    }
    res.clearCookie(AUTH_COOKIE_NAME); // حذف الكوكي من المتصفح
    res.redirect('/login');
});

// عرض معلومات طالب معين (صفحة عامة للطالب)
app.get('/info/:code', async (req, res) => {
    try {
        const uniqueCode = req.params.code;
        
        const result = await db.query("SELECT * FROM students");
        const allStudents = result.rows.map(parseStudentData);

        const currentStudent = allStudents.find(r => r.unique_code === uniqueCode);
        
        if (!currentStudent) {
            return res.status(404).render('error', { message: 'هذا الكود غير صحيح أو الطالب غير موجود.' });
        }
        
        const studentData = currentStudent.data || {};
        const studentSessions = studentData.sessions || [];
        const studentExams = studentData.exams || {};

        const stats = {
            session: { average: 0, rank: 0, classAverage: 0, rankPercentage: 0 },
            exams: {}
        };

        const studentSessionGrades = studentSessions.map(s => s.grade);
        stats.session.average = calculateAverage(studentSessionGrades);
        
        const allSessionAverages = allStudents
            .map(s => calculateAverage(s.data && s.data.sessions ? s.data.sessions.map(ses => ses.grade) : []))
            .filter(avg => avg > 0)
            .sort((a, b) => b - a);
            
        stats.session.rank = allSessionAverages.indexOf(stats.session.average) + 1;
        stats.session.classAverage = calculateAverage(allSessionAverages);
        if (allSessionAverages.length > 0) {
            stats.session.rankPercentage = (stats.session.rank / allSessionAverages.length) * 100;
        }

        Object.keys(studentExams).forEach(examName => {
            // <-- التغيير هنا: تحويل درجة الطالب إلى رقم
            const studentExamGrade = Number(studentExams[examName]);
            
            // <-- التغيير هنا: التأكد من تحويل كل الدرجات إلى أرقام قبل الفلترة والترتيب
            const allExamGrades = allStudents
                .map(s => s.data && s.data.exams ? Number(s.data.exams[examName]) : null)
                .filter(g => typeof g === 'number' && isFinite(g) && g > 0)
                .sort((a, b) => b - a);
            
            const rank = allExamGrades.indexOf(studentExamGrade) + 1;
            
            stats.exams[examName] = {
                grade: studentExamGrade,
                rank: rank > 0 ? rank : 'N/A',
                classAverage: calculateAverage(allExamGrades).toFixed(1),
                totalStudents: allExamGrades.length,
                rankPercentage: rank > 0 ? (rank / allExamGrades.length) * 100 : 100,
            };
        });

        res.render('student-info', {
            student: currentStudent,
            data: studentData,
            stats: stats
        });

    } catch (error) {
        console.error("Error fetching student info for code:", req.params.code, error);
        res.status(500).render('error', { message: 'خطأ في جلب بيانات الطالب.' });
    }
});

// التحقق من مسح QR وتسجيل الحضور (عام لأنه يأتي من جهاز الطالب)
app.post('/scan/verify', async (req, res) => {
    const { token, unique_code } = req.body;
    
    console.log(`\n--- [SCAN VERIFY] Received Request ---`);
    console.log(`Student Code: ${unique_code}, Token: ${token}`);

    if (!token || !unique_code) {
        return res.status(400).json({ success: false, message: 'بيانات ناقصة.' });
    }

    try {
        const activeSessionResult = await db.query("SELECT id, qr_secret, session_uuid FROM sessions WHERE qr_enabled = true LIMIT 1");
        
        if (activeSessionResult.rows.length === 0 || !activeSessionResult.rows[0].session_uuid) {
            return res.status(400).json({ success: false, message: 'لا يوجد حصة مفعلة لتسجيل الحضور حالياً.' });
        }
        
        const activeSession = activeSessionResult.rows[0];

        const isValid = speakeasy.totp.verify({
            secret: activeSession.qr_secret,
            encoding: 'base32',
            token: token,
            step: 500, // تأكد أن هذه القيمة تطابق ما تستخدمه
            window: 2
        });

        if (!isValid) {
            return res.status(400).json({ success: false, message: 'الرمز غير صحيح أو انتهت صلاحيته. حاول مرة أخرى.' });
        }
        
        const client = await db.connect();
        try {
            await client.query('BEGIN');
            const studentResult = await client.query("SELECT data FROM students WHERE unique_code = $1", [unique_code]);
            if (studentResult.rows.length === 0) throw new Error("الطالب غير موجود.");

            let studentData = studentResult.rows[0].data;
            let sessions = studentData.sessions || [];
            
            const sessionIndex = sessions.findIndex(s => s.uuid === activeSession.session_uuid);
            if (sessionIndex === -1) throw new Error("هذا الطالب لا يمتلك هذه الحصة في بياناته.");
            
            studentData.sessions[sessionIndex].attendance = "حاضر";
            
            await client.query("UPDATE students SET data = $1 WHERE unique_code = $2", [JSON.stringify(studentData), unique_code]);
            await client.query('COMMIT');
            res.json({ success: true, message: 'تم تسجيل حضورك بنجاح!' });
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }

    } catch (error) {
        console.error("[SCAN VERIFY] Final catch block error:", error);
        res.status(500).json({ success: false, message: error.message || 'حدث خطأ في الخادم.' });
    }
});


// --- 8. الصفحات المحمية (تتطلب تسجيل الدخول) ---

// عرض صفحة الرفع (محمية)
app.get('/upload', requireAuth, (req, res) => {
    res.render('upload', { error: null, success: null });
});

// معالجة رفع ملف الإكسل (محمية)
app.post('/upload', requireAuth, upload.single('sheet'), async (req, res) => {
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
                            studentData.sessions[sessionNumber - 1].grade = value !== null ? Number(value) : null;
                        }
                    } else if (header.includes("حضور حصة")) {
                        const match = header.match(/\d+/);
                        if (match) {
                            const sessionNumber = parseInt(match[0], 10);
                            while (studentData.sessions.length < sessionNumber) studentData.sessions.push({ grade: null, attendance: null });
                            studentData.sessions[sessionNumber - 1].attendance = value;
                        }
                    } else if (header.includes("امتحان") || header.includes("مراجعة")) {
                        studentData.exams[header] = value !== null ? Number(value) : null;
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

// عرض الداش بورد الرئيسية (محمية)
app.get('/dashboard', requireAuth, async (req, res) => {
    try {
        const result = await db.query("SELECT * FROM students");
        const students = result.rows.map(parseStudentData);
        const totalStudents = students.length;

        if (totalStudents === 0) {
            return res.render('dashboard', { hasData: false });
        }

        // --- 1. حسابات الطلاب الفردية (القسم المصحح) ---
        students.forEach(student => {
            const sData = student.data || { sessions: [], exams: {} };
            const sSessions = sData.sessions || [];
            const sExams = sData.exams || {};
            
            // درجات الحصص (عادة ما تكون أرقام بالفعل)
            const studentSessionGrades = sSessions
                .map(s => s?.grade)
                .filter(g => typeof g === 'number' && isFinite(g));
            
            // <-- التغيير الرئيسي هنا: تحويل قيم الامتحانات إلى أرقام قبل الفلترة
            const studentExamGrades = Object.values(sExams)
                .map(value => Number(value)) // تحويل كل قيمة إلى رقم
                .filter(grade => typeof grade === 'number' && isFinite(grade)); // فلترة القيم غير الرقمية

            student.calculated_session_avg = calculateAverage(studentSessionGrades);
            student.calculated_exam_avg = calculateAverage(studentExamGrades);
            student.calculated_overall_avg = calculateAverage([ ...studentExamGrades]);
            student.attendance_percentage = sSessions.length > 0 ? (sSessions.filter(s => s?.attendance === 'حاضر').length / sSessions.length) * 100 : 0;
        // ...studentSessionGrades,
        
        });

        // --- 2. تجميع البيانات وحساب KPIs ---
        const examData = {};
        students.forEach(student => {
            const sExams = student.data?.exams || {};
            Object.entries(sExams).forEach(([examName, grade]) => {
                const numericGrade = Number(grade); // تحويل الدرجة لرقم
                if (typeof numericGrade === 'number' && isFinite(numericGrade)) {
                    if (!examData[examName]) examData[examName] = { grades: [], sum: 0, count: 0, highest: -Infinity, lowest: Infinity };
                    examData[examName].grades.push(numericGrade);
                    examData[examName].sum += numericGrade;
                    examData[examName].count++;
                    examData[examName].highest = Math.max(examData[examName].highest, numericGrade);
                    examData[examName].lowest = Math.min(examData[examName].lowest, numericGrade);
                }
            });
        });

        const overallAttendance = calculateAverage(students.map(s => s.attendance_percentage));
        const classOverallAverage = calculateAverage(students.map(s => s.calculated_overall_avg));
        
        students.sort((a, b) => (b.calculated_overall_avg || 0) - (a.calculated_overall_avg || 0));
        
        const topPerformer = students[0] || null;
        const atRiskCount = students.filter(s => (s.calculated_overall_avg || 0) < 6.5).length;
        
        let mostImprovedStudent = { name: 'لا يوجد', improvement: -Infinity };
        students.forEach(s => {
            const sessions = s.data?.sessions || [];
            if (sessions.length > 1) {
                const sessionGrades = sessions.map(ses => ses?.grade).filter(g => typeof g === 'number' && isFinite(g));
                if (sessionGrades.length > 1) {
                    const half = Math.ceil(sessionGrades.length / 2);
                    const firstHalfAvg = calculateAverage(sessionGrades.slice(0, half));
                    const secondHalfAvg = calculateAverage(sessionGrades.slice(half));
                    if (secondHalfAvg > 0 && firstHalfAvg > 0) {
                        const improvement = (secondHalfAvg - firstHalfAvg);
                        if (improvement > mostImprovedStudent.improvement) {
                            mostImprovedStudent = { name: s.student_name, improvement: improvement };
                        }
                    }
                }
            }
        });

        // --- 3. تجهيز بيانات المخططات الجديدة (تعتمد الآن على الحسابات الصحيحة) ---
        const examComparisonData = {
            labels: [],
            sessionAvgs: [],
            examAvgs: []
        };
        const overallSessionAvgForClass = calculateAverage(students.map(s => s.calculated_session_avg));
        
        Object.keys(examData).forEach(examName => {
            examComparisonData.labels.push(examName);
            examComparisonData.sessionAvgs.push(overallSessionAvgForClass); 
            examComparisonData.examAvgs.push(calculateAverage(examData[examName].grades));
        });

        const top5Students = students.slice(0, 5);
        const bottom5Students = [...students].reverse().slice(0, 5);
        const performanceGapData = {
            labels: [...top5Students.map(s => s.student_name), ...bottom5Students.map(s => s.student_name)],
            averages: [...top5Students.map(s => s.calculated_overall_avg), ...bottom5Students.map(s => s.calculated_overall_avg)],
            colors: [...top5Students.map(() => '#22c55e'), ...bottom5Students.map(() => '#ef4444')]
        };

        // --- 4. تجهيز باقي البيانات (تعتمد الآن على الحسابات الصحيحة) ---
        const examDetails = Object.keys(examData).map(name => {
            const avg = examData[name].count > 0 ? (examData[name].sum / examData[name].count) : 0;
            const variance = examData[name].grades.map(x => Math.pow(x - avg, 2)).reduce((a, b) => a + b, 0) / examData[name].count;
            return {
                name,
                average: avg.toFixed(1),
                participants: examData[name].count,
                highest: examData[name].highest === -Infinity ? 'N/A' : examData[name].highest,
                lowest: examData[name].lowest === Infinity ? 'N/A' : examData[name].lowest,
                stdDev: examData[name].count > 0 ? Math.sqrt(variance).toFixed(2) : 'N/A'
            };
        });
        const studentLeaderboard = students.map((s, index) => ({ 
            rank: index + 1,
            name: s.student_name,
            unique_code: s.unique_code,
            overall_avg: (s.calculated_overall_avg || 0).toFixed(1),
            session_avg: (s.calculated_session_avg || 0).toFixed(1),
            exam_avg: (s.calculated_exam_avg || 0).toFixed(1),
            attendance: (s.attendance_percentage || 0).toFixed(0)
         }));
        const attendanceVsSessionPerformance = students.filter(s => s.calculated_session_avg > 0).map(s => ({ x: s.attendance_percentage, y: s.calculated_session_avg, label: s.student_name }));
        const attendanceVsExamPerformance = students.filter(s => s.calculated_exam_avg > 0).map(s => ({ x: s.attendance_percentage, y: s.calculated_exam_avg, label: s.student_name }));


        // 5. إرسال كل شيء إلى القالب
        res.render('dashboard', {
            hasData: true,
            totalStudents,
            overallAttendance: overallAttendance.toFixed(1),
            classOverallAverage: classOverallAverage.toFixed(1),
            atRiskCount,
            topPerformer,
            mostImprovedStudent,
            examComparisonData,
            performanceGapData,
            examDetails,
            studentLeaderboard,
            attendanceVsSessionPerformance,
            attendanceVsExamPerformance
        });

    } catch (error) {
        console.error("!!! CRITICAL ERROR IN /dashboard ROUTE !!!", error);
        res.status(500).render('error', { message: 'حدث خطأ فادح أثناء حساب تحليلات الداش بورد.' });
    }
});

// عرض تفاصيل امتحان معين (محمية)
app.get('/exam/:examName', requireAuth, async (req, res) => {
    try {
        const examName = decodeURIComponent(req.params.examName);
        const result = await db.query("SELECT student_name, unique_code, data FROM students");
        const studentsWithGrade = result.rows.map(parseStudentData).map(row => {
            if (row.data.exams && typeof row.data.exams[examName] !== 'undefined' && row.data.exams[examName] !== null) {
                return { name: row.student_name, unique_code: row.unique_code, grade: Number(row.data.exams[examName]) };
            }
            return null;
        }).filter(Boolean).sort((a, b) => b.grade - a.grade);
        res.render('exam-details', { examName, students: studentsWithGrade });
    } catch(error) {
        console.error(`Error fetching details for exam ${req.params.examName}:`, error);
        res.status(500).render('error', { message: 'خطأ في جلب تفاصيل الامتحان.' });
    }
});

// تصدير البيانات كملف CSV (محمية)
app.get('/export/csv', requireAuth, async (req, res) => {
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

// لوحة التحكم والإدارة (محمية)
app.get('/manage', requireAuth, async (req, res) => {
    try {
        const studentsResult = await db.query("SELECT student_id, student_name, unique_code, data FROM students ORDER BY student_name");
        const sessionsResult = await db.query("SELECT * FROM sessions ORDER BY id");
        
        const allExamNames = new Set();
        const studentsWithParsedData = studentsResult.rows.map(parseStudentData);
        
        studentsWithParsedData.forEach(student => {
            if (student.data && student.data.exams) {
                Object.keys(student.data.exams).forEach(examName => {
                    allExamNames.add(examName);
                });
            }
        });
        
        const successMessage = req.query.success ? 'تمت العملية بنجاح!' : null;
        const errorMessage = req.query.error ? 'حدث خطأ ما.' : null;


        res.render('manage-dashboard', {
            students: studentsResult.rows.map(({ data, ...student }) => student), 
            sessions: sessionsResult.rows,
            examNames: Array.from(allExamNames),
            success: successMessage,
            error: errorMessage
        });
    } catch (error) {
        console.error("Error loading management dashboard:", error);
        res.status(500).render('error', { message: 'خطأ في تحميل لوحة الإدارة.' });
    }
});

// عرض صفحة تعديل طالب (محمية)
app.get('/manage/student/:code', requireAuth, async (req, res) => {
    try {
        const { code } = req.params;
        const result = await db.query("SELECT * FROM students WHERE unique_code = $1", [code]);
        if (result.rows.length === 0) {
            return res.status(404).render('error', { message: 'الطالب غير موجود.' });
        }
        const student = parseStudentData(result.rows[0]);
        const successMessage = req.query.success ? 'تم حفظ التغييرات بنجاح!' : null;
        res.render('edit-student', { student, success: successMessage });
    } catch (error) {
        console.error("Error fetching student for editing:", error);
        res.status(500).render('error', { message: 'خطأ في جلب بيانات الطالب للتعديل.' });
    }
});

// تحديث بيانات طالب (محمية)
app.post('/manage/student/:code', requireAuth, async (req, res) => {
    const { code } = req.params;
    const { student_name, student_id, sessions, exams, personal_message } = req.body;

    try {
        const studentResult = await db.query("SELECT data FROM students WHERE unique_code = $1", [code]);
        if (studentResult.rows.length === 0) {
            return res.status(404).render('error', { message: 'الطالب غير موجود.' });
        }
        
        const currentData = studentResult.rows[0].data || {};

        const updatedData = {
            ...currentData, 
            sessions: (sessions || []).map(s => ({
                grade: s.grade ? Number(s.grade) : null,
                attendance: s.attendance || null,
                uuid: s.uuid || null 
            })),
            exams: exams || {},
            personal_message: personal_message || ""
        };

        await db.query(
            "UPDATE students SET student_name = $1, student_id = $2, data = $3 WHERE unique_code = $4",
            [student_name, student_id, JSON.stringify(updatedData), code]
        );
        
        res.redirect(`/manage/student/${code}?success=true`);

    } catch (error) {
        console.error("Error updating student data:", error);
        res.status(500).render('error', { message: 'فشل تحديث بيانات الطالب.' });
    }
});

// إضافة حصة جديدة لكل الطلاب (محمية)
app.post('/manage/session/add', requireAuth, async (req, res) => {
    const { sessionName } = req.body;
    if (!sessionName) {
        return res.status(400).send('اسم الحصة مطلوب');
    }
    const client = await db.connect();
    try {
        await client.query('BEGIN');
        
        const newSecret = speakeasy.generateSecret({ length: 20 }).base32;
        const newSessionUUID = uuidv4(); 
        await client.query(
            "INSERT INTO sessions (name, qr_secret, session_uuid) VALUES ($1, $2, $3)",
            [sessionName, newSecret, newSessionUUID]
        );

        const newSessionObject = JSON.stringify({
            uuid: newSessionUUID,
            grade: null,
            attendance: "غائب"
        });

        const updateQuery = `
            UPDATE students
            SET data = jsonb_set(
                data,
                '{sessions}',
                COALESCE(data->'sessions', '[]'::jsonb) || $1::jsonb,
                true
            )
        `;
        await client.query(updateQuery, [newSessionObject]);

        await client.query('COMMIT');
        res.redirect('/manage');
    } catch (error) {
        await client.query('ROLLBACK');
        console.error("Error adding new session for all students:", error);
        res.status(500).render('error', { message: 'فشل إضافة حصة جديدة للطلاب.' });
    } finally {
        client.release();
    }
});

// تفعيل/إلغاء QR للحصة (محمية)
app.post('/manage/session/toggle-qr/:id', requireAuth, async (req, res) => {
    const { id } = req.params;
    const client = await db.connect();
    try {
        await client.query('BEGIN');
        await client.query("UPDATE sessions SET qr_enabled = false WHERE id != $1", [id]);
        
        const result = await client.query(
            "UPDATE sessions SET qr_enabled = NOT qr_enabled WHERE id = $1 RETURNING qr_enabled",
            [id]
        );
        
        await client.query('COMMIT');
        res.json({ success: true, newState: result.rows[0].qr_enabled });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error("Error toggling QR status:", error);
        res.status(500).json({ success: false });
    } finally {
        client.release();
    }
});

// توليد صورة QR Code (محمية)
app.get('/manage/session/qr-code/:id', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const result = await db.query("SELECT qr_secret FROM sessions WHERE id = $1", [id]);
        if (result.rows.length === 0 || !result.rows[0].qr_secret) {
            return res.status(404).send('Session or secret not found.');
        }
        
        const secret = result.rows[0].qr_secret;
        const token = speakeasy.totp({
            secret: secret,
            encoding: 'base32',
            step: 500
        });
        
        qrcode.toDataURL(token, (err, data_url) => {
            if (err) throw err;
            res.send(`<img src="${data_url}" alt="QR Code" />`);
        });

    } catch (error) {
        console.error("Error generating QR code:", error);
        res.status(500).send('Error generating QR code');
    }
});

// حذف حصة (محمية)
app.post('/manage/session/delete/:id', requireAuth, async (req, res) => {
    const { id } = req.params;
    const client = await db.connect();
    try {
        await client.query('BEGIN');
        const sessionResult = await client.query("SELECT session_uuid FROM sessions WHERE id = $1", [id]);
        if (sessionResult.rows.length === 0) {
            throw new Error('لم يتم العثور على الحصة لحذفها.');
        }
        const sessionUUIDToDelete = sessionResult.rows[0].session_uuid;
        await client.query("DELETE FROM sessions WHERE id = $1", [id]);
        if (sessionUUIDToDelete) {
            const updateStudentsQuery = `
                UPDATE students
                SET data = jsonb_set(
                    data,
                    '{sessions}',
                    COALESCE(
                        (
                            SELECT jsonb_agg(elem)
                            FROM jsonb_array_elements(data->'sessions') AS elem
                            WHERE (elem->>'uuid')::uuid != $1
                        ),
                        '[]'::jsonb
                    )
                )
                WHERE data->'sessions' @> $2::jsonb;
            `;
            const sessionJsonToFind = `[{"uuid": "${sessionUUIDToDelete}"}]`;
            await client.query(updateStudentsQuery, [sessionUUIDToDelete, sessionJsonToFind]);
        }
        await client.query('COMMIT');
        res.redirect('/manage');
    } catch (error) {
        await client.query('ROLLBACK');
        console.error("Error deleting session:", error);
        res.status(500).render('error', { message: 'فشل حذف الحصة.' });
    } finally {
        client.release();
    }
});

// عرض صفحة الماسح الضوئي للمدرس (محمية)
app.get('/manage/session/scan/:id', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const result = await db.query(
            "SELECT id, name, qr_enabled FROM sessions WHERE id = $1 AND qr_enabled = true",
            [id]
        );
        if (result.rows.length === 0) {
            return res.status(403).send('<h1>لا يمكن بدء المسح. يرجى تفعيل الحضور لهذه الحصة أولاً من لوحة التحكم.</h1><a href="/manage">العودة للوحة التحكم</a>');
        }
        const session = result.rows[0];
        res.render('scanner', { session });
    } catch (error) {
        console.error("Error loading scanner page:", error);
        res.status(500).render('error', { message: 'خطأ في تحميل صفحة الماسح الضوئي.' });
    }
});

// معالجة الباركود المسجل وتحديث الحضور (محمية)
app.post('/scan/mark-attendance', requireAuth, async (req, res) => {
    const { unique_code } = req.body;
    if (!unique_code) {
        return res.status(400).json({ success: false, message: 'كود الطالب مطلوب.' });
    }
    const client = await db.connect();
    try {
        const activeSessionResult = await client.query("SELECT session_uuid FROM sessions WHERE qr_enabled = true LIMIT 1");
        if (activeSessionResult.rows.length === 0) {
            return res.status(400).json({ success: false, message: 'لا توجد حصة مفعلة لتسجيل الحضور.' });
        }
        const activeSessionUUID = activeSessionResult.rows[0].session_uuid;
        await client.query('BEGIN');
        const studentResult = await client.query("SELECT student_name, data FROM students WHERE unique_code = $1", [unique_code]);
        if (studentResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, message: `الطالب صاحب الكود ${unique_code} غير موجود.` });
        }
        let studentData = studentResult.rows[0].data;
        const studentName = studentResult.rows[0].student_name;
        let sessions = studentData.sessions || [];
        const sessionIndex = sessions.findIndex(s => s.uuid === activeSessionUUID);
        if (sessionIndex === -1) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, message: `الطالب ${studentName} لا يملك هذه الحصة في بياناته.` });
        }
        if (studentData.sessions[sessionIndex].attendance === "حاضر") {
             await client.query('ROLLBACK');
             return res.json({ success: true, studentName: studentName, message: 'مسجل بالفعل' });
        }
        studentData.sessions[sessionIndex].attendance = "حاضر";
        await client.query("UPDATE students SET data = $1 WHERE unique_code = $2", [JSON.stringify(studentData), unique_code]);
        await client.query('COMMIT');
        res.json({ success: true, studentName: studentName, message: 'تم التسجيل' });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error("Error marking attendance:", error);
        res.status(500).json({ success: false, message: 'حدث خطأ في الخادم.' });
    } finally {
        client.release();
    }
});

// إضافة امتحان جديد لكل الطلاب (محمية)
app.post('/manage/exam/add', requireAuth, async (req, res) => {
    const { examName } = req.body;
    if (!examName || examName.trim() === '') {
        return res.status(400).redirect('/manage?error=ExamNameRequired');
    }
    const client = await db.connect();
    try {
        const query = `
            UPDATE students
            SET data = jsonb_set(
                COALESCE(data, '{}'::jsonb),
                $1,
                'null'::jsonb,
                true
            )
        `;
        const path = ['exams', examName]; 
        await client.query(query, [path]);
        res.redirect('/manage?success=ExamAdded');
    } catch (error) {
        console.error("Error adding new major exam:", error);
        res.status(500).render('error', { message: 'فشل إضافة امتحان جديد.' });
    } finally {
        client.release();
    }
});

// النسخ الاحتياطي لقاعدة البيانات (محمية)
app.get('/manage/backup', requireAuth, async (req, res) => {
    try {
        const studentsResult = await db.query("SELECT * FROM students");
        const sessionsResult = await db.query("SELECT * FROM sessions");
        const backupData = {
            students: studentsResult.rows,
            sessions: sessionsResult.rows,
            backup_date: new Date().toISOString()
        };
        const fileName = `backup-${new Date().toISOString().split('T')[0]}.json`;
        res.header('Content-Type', 'application/json');
        res.attachment(fileName);
        res.send(JSON.stringify(backupData, null, 2));
    } catch (error) {
        console.error("Error creating backup:", error);
        res.status(500).render('error', { message: 'فشل إنشاء النسخة الاحتياطية.' });
    }
});

// استعادة قاعدة البيانات (محمية)
app.post('/manage/restore', requireAuth, backupUpload.single('backupFile'), async (req, res) => {
    if (!req.file) {
        return res.status(400).send('الرجاء رفع ملف النسخة الاحتياطية.');
    }
    // لا نحتاج للتحقق من كلمة السر هنا لأن requireAuth قام بذلك
    const client = await db.connect();
    try {
        const backupData = JSON.parse(req.file.buffer.toString('utf-8'));
        if (!backupData.students || !backupData.sessions) {
            throw new Error('ملف النسخة الاحتياطية غير صالح أو تالف.');
        }
        await client.query('BEGIN');
        await client.query('DELETE FROM students');
        await client.query('DELETE FROM sessions');
        const sessionInsertQuery = `
          INSERT INTO sessions (id, name, qr_secret, qr_enabled, session_uuid)
          VALUES ($1, $2, $3, $4, $5)
        `;
        for (const session of backupData.sessions) {
            await client.query(sessionInsertQuery, [session.id, session.name, session.qr_secret, session.qr_enabled, session.session_uuid]);
        }
        const studentInsertQuery = `
          INSERT INTO students (student_id, student_name, unique_code, data)
          VALUES ($1, $2, $3, $4)
        `;
        for (const student of backupData.students) {
            await client.query(studentInsertQuery, [
                student.student_id,
                student.student_name,
                student.unique_code,
                typeof student.data === 'string' ? student.data : JSON.stringify(student.data)
            ]);
        }
        await client.query('COMMIT');
        res.send('<h1>تمت استعادة البيانات بنجاح!</h1><a href="/manage">العودة للوحة التحكم</a>');
    } catch (error) {
        await client.query('ROLLBACK');
        console.error("Error restoring from backup:", error);
        res.status(500).render('error', { message: `فشل استعادة البيانات. الخطأ: ${error.message}` });
    } finally {
        client.release();
    }
});

// عرض صفحة التعديل الجماعي (محمية)
app.get('/manage/bulk-edit', requireAuth, async (req, res) => {
    const { type, name } = req.query;
    if (!type || !name) {
        return res.status(400).render('error', { message: 'بيانات غير كافية لعرض صفحة التعديل.' });
    }
    try {
        const result = await db.query("SELECT student_name, unique_code, data FROM students ORDER BY student_name");
        const students = result.rows.map(parseStudentData);
        const pageData = {
            editType: type,
            itemName: name,
            students: students
        };
        res.render('bulk-edit', pageData);
    } catch (error) {
        console.error("Error loading bulk edit page:", error);
        res.status(500).render('error', { message: 'فشل تحميل صفحة التعديل الجماعي.' });
    }
});

// معالجة التعديل الجماعي (محمية)
app.post('/manage/bulk-edit', requireAuth, async (req, res) => {
    const { editType, itemName, ...studentData } = req.body;
    const client = await db.connect();
    try {
        await client.query('BEGIN');
        for (const uniqueCode in studentData) {
            const value = studentData[uniqueCode];
            const studentResult = await client.query("SELECT data FROM students WHERE unique_code = $1", [uniqueCode]);
            if (studentResult.rows.length === 0) continue;
            let data = studentResult.rows[0].data || { sessions: [], exams: {} };
            if (editType === 'exam') {
                if (!data.exams) data.exams = {};
                data.exams[itemName] = value === '' ? null : Number(value);
            } else {
                const sessionIndex = data.sessions.findIndex(s => s.uuid === itemName);
                if (sessionIndex !== -1) {
                    if (editType === 'sessionGrade') {
                        data.sessions[sessionIndex].grade = value === '' ? null : Number(value);
                    } else if (editType === 'sessionAttendance') {
                        data.sessions[sessionIndex].attendance = value || null;
                    }
                }
            }
            await client.query("UPDATE students SET data = $1 WHERE unique_code = $2", [JSON.stringify(data), uniqueCode]);
        }
        await client.query('COMMIT');
        res.redirect('/manage?success=BulkUpdateComplete');
    } catch (error) {
        await client.query('ROLLBACK');
        console.error("Error during bulk update:", error);
        res.status(500).render('error', { message: 'فشل التحديث الجماعي للبيانات.' });
    } finally {
        client.release();
    }
});

// حذف امتحان (محمية)
app.post('/manage/exam/delete', requireAuth, async (req, res) => {
    const { examName } = req.body;
    if (!examName || examName.trim() === '') {
        return res.status(400).redirect('/manage?error=ExamNameMissing');
    }
    const client = await db.connect();
    try {
        await client.query('BEGIN');
        const studentsResult = await client.query("SELECT unique_code, data FROM students");
        for (const student of studentsResult.rows) {
            let needsUpdate = false;
            let studentData = student.data;
            if (studentData && studentData.exams && studentData.exams.hasOwnProperty(examName)) {
                delete studentData.exams[examName];
                needsUpdate = true;
            }
            if (needsUpdate) {
                const updateQuery = "UPDATE students SET data = $1 WHERE unique_code = $2";
                await client.query(updateQuery, [JSON.stringify(studentData), student.unique_code]);
            }
        }
        await client.query('COMMIT');
        res.redirect('/manage?success=ExamDeleted');
    } catch (error) {
        await client.query('ROLLBACK');
        console.error("[DELETE EXAM] Error:", error);
        res.status(500).render('error', { message: 'فشل حذف الامتحان من سجلات الطلاب.' });
    } finally {
        if (client) {
            client.release();
        }
    }
});

// --- 9. PWA and Other Routes ---
app.get('/hello', (req, res) => {
    res.send("مرحباً، العالم يعمل!");
});

app.get('/manifest.json', (req, res) => {
    const { unique_code } = req.query;
    if (!unique_code) {
        return res.status(400).json({ error: 'Student unique code is required' });
    }
    const manifest = {
        "name": "تقرير أداء الطالب",
        "short_name": "تقريري",
        "start_url": `/info/${unique_code}`,
        "display": "standalone",
        "background_color": "#f3f4f6",
        "theme_color": "#4f46e5",
        "orientation": "portrait-primary",
        "icons": [
            { "src": "/icons/icon-192x192.png", "type": "image/png", "sizes": "192x192" },
            { "src": "/icons/icon-512x512.png", "type": "image/png", "sizes": "512x512" }
        ]
    };
    res.json(manifest);
});

app.get('/sw.js', (req, res) => {
    const { unique_code } = req.query;
    if (!unique_code) {
        return res.status(400).send('// Student unique code is required');
    }
    const serviceWorkerScript = `
        const CACHE_NAME = 'student-report-cache-v1-${unique_code}';
        const urlsToCache = [
            '/',
            '/info/${unique_code}',
            '/css/style.css',
            '/js/main.js' 
        ];
        self.addEventListener('install', event => {
            event.waitUntil(
                caches.open(CACHE_NAME)
                    .then(cache => {
                        return cache.addAll(urlsToCache);
                    })
            );
        });
        self.addEventListener('fetch', event => {
            event.respondWith(
                caches.match(event.request)
                    .then(response => {
                        return response || fetch(event.request);
                    })
            );
        });
    `;
    res.type('application/javascript');
    res.send(serviceWorkerScript);
});


// --- 10. تشغيل الخادم ---
app.listen(port, () => {
    console.log(`Server is running at http://localhost:${port}`);
    console.log('To access dashboard, go to /login');
});