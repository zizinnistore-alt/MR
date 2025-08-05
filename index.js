// index.js

// 1. استدعاء المكتبات
require('dotenv').config();
const express = require('express');
const multer = require('multer');
const xlsx = require('xlsx');
const path = require('path');
const { Pool } = require('pg');
const { Parser } = require('json2csv');
const { v4: uuidv4 } = require('uuid'); 

// --- NEW LIBRARIES ---
const speakeasy = require('speakeasy');
const qrcode = require('qrcode');

// 2. إعداد Express App
const app = express();

app.get("/hello", (req, res) => {
    res.send("مرحباً، العالم يعمل!");
  });

const port = process.env.PORT || 8080;

app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.json()); // <-- NEW: Needed for AJAX requests
app.use(express.static(path.join(__dirname, 'public')));


// 3. إعداد Multer
const upload = multer({ storage: multer.memoryStorage() });

// 4. الاتصال بقاعدة البيانات (Supabase)
const db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
});

// --- EXISTING HELPER FUNCTIONS (No changes here) ---
const parseStudentData = (student) => ({
    ...student,
    data: typeof student.data === 'string' ? JSON.parse(student.data) : student.data,
});
const calculateAverage = (arr) => {
    const validGrades = arr.filter(g => typeof g === 'number' && g > 0);
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
// في ملف index.js

// عرض معلومات طالب معين
app.get('/info/:code', async (req, res) => {
    try {
        const uniqueCode = req.params.code;
        
        const result = await db.query("SELECT * FROM students");
        const allStudents = result.rows.map(parseStudentData);

        const currentStudent = allStudents.find(r => r.unique_code === uniqueCode);
        
        if (!currentStudent) {
            return res.status(404).render('error', { message: 'هذا الكود غير صحيح أو الطالب غير موجود.' });
        }
        
        // --- التحصين يبدأ هنا ---
        // تأكد من أن data و sessions و exams هي كائنات/مصفوفات وليست null
        const studentData = currentStudent.data || {};
        const studentSessions = studentData.sessions || [];
        const studentExams = studentData.exams || {};
        // -------------------------

        const stats = {
            session: { average: 0, rank: 0, classAverage: 0, rankPercentage: 0 },
            exams: {}
        };

        // استخدم المتغيرات المحصنة
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
            const studentExamGrade = studentExams[examName];
            const allExamGrades = allStudents
                .map(s => s.data && s.data.exams ? s.data.exams[examName] : null)
                .filter(g => typeof g === 'number' && g > 0)
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
            data: studentData, // أرسل البيانات المحصنة
            stats: stats 
        });

    } catch (error) {
        console.error("Error fetching student info for code:", req.params.code, error);
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

// --- START: NEW MANAGEMENT & QR ROUTES ---

// 1. Management Dashboard
app.get('/manage', async (req, res) => {
    try {
        const studentsResult = await db.query("SELECT student_id, student_name, unique_code FROM students ORDER BY student_name");
        const sessionsResult = await db.query("SELECT * FROM sessions ORDER BY id");
        res.render('manage-dashboard', {
            students: studentsResult.rows,
            sessions: sessionsResult.rows,
            error: null,
            success: null
        });
    } catch (error) {
        console.error("Error loading management dashboard:", error);
        res.status(500).render('error', { message: 'خطأ في تحميل لوحة الإدارة.' });
    }
});

// 2. Edit Student Page (GET)
app.get('/manage/student/:code', async (req, res) => {
    try {
        const { code } = req.params;
        const result = await db.query("SELECT * FROM students WHERE unique_code = $1", [code]);
        if (result.rows.length === 0) {
            return res.status(404).render('error', { message: 'الطالب غير موجود.' });
        }
        const student = parseStudentData(result.rows[0]);
        res.render('edit-student', { student });
    } catch (error) {
        console.error("Error fetching student for editing:", error);
        res.status(500).render('error', { message: 'خطأ في جلب بيانات الطالب للتعديل.' });
    }
});

// 3. Update Student Data (POST)
app.post('/manage/student/:code', async (req, res) => {
    const { code } = req.params;
    const { student_name, student_id, sessions, exams } = req.body;

    // Reconstruct the data JSON object from form data
    const updatedData = {
        sessions: (sessions || []).map(s => ({
            grade: s.grade ? Number(s.grade) : null,
            attendance: s.attendance || null
        })),
        exams: exams || {}
    };

    try {
        await db.query(
            "UPDATE students SET student_name = $1, student_id = $2, data = $3 WHERE unique_code = $4",
            [student_name, student_id, JSON.stringify(updatedData), code]
        );
        res.redirect('/manage');
    } catch (error) {
        console.error("Error updating student data:", error);
        res.status(500).render('error', { message: 'فشل تحديث بيانات الطالب.' });
    }
});


// 4. Add a new session for all students
app.post('/manage/session/add', async (req, res) => {
    const { sessionName } = req.body;
    if (!sessionName) {
        return res.status(400).send('اسم الحصة مطلوب');
    }
    const client = await db.connect();
    try {
        await client.query('BEGIN');
        
        // الخطوة 1: إضافة الحصة الجديدة إلى جدول الحصص الرئيسي
        const newSecret = speakeasy.generateSecret({ length: 20 }).base32;
        // سنضيف حقلاً جديداً في جدول sessions اسمه session_uuid
        // تأكد من إضافة هذا العمود إلى جدولك في Supabase (انظر التعليمات بالأسفل)
        const newSessionUUID = uuidv4(); 
        await client.query(
            "INSERT INTO sessions (name, qr_secret, session_uuid) VALUES ($1, $2, $3)",
            [sessionName, newSecret, newSessionUUID]
        );

        // الخطوة 2: تحديث بيانات كل طالب لإضافة الحصة الجديدة
        const newSessionObject = JSON.stringify({
            uuid: newSessionUUID, // معرف فريد لهذه الحصة
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

// 5. Toggle QR Attendance for a session
app.post('/manage/session/toggle-qr/:id', async (req, res) => {
    const { id } = req.params;
    const client = await db.connect();
    try {
        await client.query('BEGIN');
        // First, disable QR for all other sessions to ensure only one is active
        await client.query("UPDATE sessions SET qr_enabled = false WHERE id != $1", [id]);
        
        // Then, toggle the selected session
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


// 6. Generate QR Code image
app.get('/manage/session/qr-code/:id', async (req, res) => {
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
            step: 500//he token changes every 5 seconds غير القيمة دي لو عايز تغير وقت تغيي الكيو ار كود
        });
        
        // Generate QR code and send it as an image
        qrcode.toDataURL(token, (err, data_url) => {
            if (err) throw err;
            res.send(`<img src="${data_url}" alt="QR Code" />`);
        });

    } catch (error) {
        console.error("Error generating QR code:", error);
        res.status(500).send('Error generating QR code');
    }
});

// NEW: Delete a session (CORRECTED VERSION)
app.post('/manage/session/delete/:id', async (req, res) => {
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
            // الاستعلام المُصحح: يستخدم COALESCE لوضع مصفوفة فارغة إذا كانت النتيجة NULL
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
                        '[]'::jsonb -- إذا كانت النتيجة NULL، استخدم مصفوفة فارغة
                    )
                )
                WHERE data->'sessions' @> $2::jsonb;
            `;
            // نمرر الـ UUID في صيغة JSON للبحث
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

// 7. Verify QR scan and record attendance
app.post('/scan/verify', async (req, res) => {
    const { token, unique_code } = req.body;
    
    // --- طباعة البيانات المستلمة ---
    console.log(`\n--- [SCAN VERIFY] Received Request ---`);
    console.log(`Student Code: ${unique_code}, Token: ${token}`);
    
    if (!token || !unique_code) {
        return res.status(400).json({ success: false, message: 'بيانات ناقصة.' });
    }

    try {
        const activeSessionResult = await db.query("SELECT id, qr_secret, session_uuid FROM sessions WHERE qr_enabled = true LIMIT 1");
        
        if (activeSessionResult.rows.length === 0 || !activeSessionResult.rows[0].session_uuid) {
            console.log("[SCAN VERIFY] Error: No active session found for QR attendance.");
            return res.status(400).json({ success: false, message: 'لا يوجد حصة مفعلة لتسجيل الحضور حالياً.' });
        }
        
        const activeSession = activeSessionResult.rows[0];
        console.log(`[SCAN VERIFY] Active Session Found: UUID = ${activeSession.session_uuid}`);

        const isValid = speakeasy.totp.verify({
            secret: activeSession.qr_secret,
            encoding: 'base32',
            token: token,
            step: 500, // تأكد أن هذه القيمة تطابق ما تستخدمه
            window: 2
        });

        if (!isValid) {
            console.log("[SCAN VERIFY] Error: Invalid or expired token.");
            return res.status(400).json({ success: false, message: 'الرمز غير صحيح أو انتهت صلاحيته. حاول مرة أخرى.' });
        }
        console.log("[SCAN VERIFY] Token is valid.");

        const client = await db.connect();
        try {
            await client.query('BEGIN');

            const studentResult = await client.query("SELECT data FROM students WHERE unique_code = $1", [unique_code]);
            if (studentResult.rows.length === 0) {
                throw new Error("الطالب غير موجود.");
            }

            let studentData = studentResult.rows[0].data;
            let sessions = studentData.sessions || [];
            
            // --- طباعة بيانات الطالب قبل التعديل ---
            console.log(`[SCAN VERIFY] Student data BEFORE update:`, JSON.stringify(studentData, null, 2));

            const sessionIndex = sessions.findIndex(s => s.uuid === activeSession.session_uuid);
            console.log(`[SCAN VERIFY] Searching for session UUID ${activeSession.session_uuid}... Found at index: ${sessionIndex}`);

            if (sessionIndex === -1) {
                throw new Error("هذا الطالب لا يمتلك هذه الحصة في بياناته.");
            }

            // تحديث الحضور
            studentData.sessions[sessionIndex].attendance = "حاضر";
            
            // --- طباعة بيانات الطالب بعد التعديل ---
            console.log(`[SCAN VERIFY] Student data AFTER update:`, JSON.stringify(studentData, null, 2));

            const updateResult = await client.query("UPDATE students SET data = $1 WHERE unique_code = $2", [JSON.stringify(studentData), unique_code]);
            console.log(`[SCAN VERIFY] Database update result: ${updateResult.rowCount} row(s) affected.`);

            await client.query('COMMIT');
            console.log(`[SCAN VERIFY] COMMIT successful. Sending success response.`);
            res.json({ success: true, message: 'تم تسجيل حضورك بنجاح!' });
        } catch (error) {
            await client.query('ROLLBACK');
            console.error(`[SCAN VERIFY] Error during transaction:`, error);
            throw error;
        } finally {
            client.release();
        }

    } catch (error) {
        console.error("[SCAN VERIFY] Final catch block error:", error);
        res.status(500).json({ success: false, message: error.message || 'حدث خطأ في الخادم.' });
    }
});

// --- END: NEW MANAGEMENT & QR ROUTES ---
// في ملف الخادم (app.js)
app.get('/manifest.json', (req, res) => {
    const { unique_code } = req.query; // نحصل على كود الطالب من الرابط
    if (!unique_code) {
        return res.status(400).json({ error: 'Student unique code is required' });
    }

    const manifest = {
        "name": "تقرير أداء الطالب",
        "short_name": "تقريري",
        "start_url": `/info/${unique_code}`, // هذا هو الرابط الذي سيفتح عند تشغيل التطبيق
        "display": "standalone",
        "background_color": "#f3f4f6", // bg-gray-100
        "theme_color": "#4f46e5", // bg-indigo-600
        "orientation": "portrait-primary",
        "icons": [
            {
                "src": "/icons/icon-192x192.png",
                "type": "image/png",
                "sizes": "192x192"
            },
            {
                "src": "/icons/icon-512x512.png",
                "type": "image/png",
                "sizes": "512x512"
            }
        ]
    };

    res.json(manifest);
});

app.get('/sw.js', (req, res) => {
    // لا يوجد require هنا الآن
    const { unique_code } = req.query;
    if (!unique_code) {
        return res.status(400).send('// Student unique code is required');
    }

    // هذا هو الكود الذي سيتم إرساله كملف sw.js
    const serviceWorkerScript = `
        const CACHE_NAME = 'student-report-cache-v1';
        // ... باقي كود الـ service worker ...
    `;

    res.type('application/javascript');
    res.send(serviceWorkerScript);
});




// 1. عرض صفحة الماسح الضوئي للحصة المحددة
app.get('/manage/session/scan/:id', async (req, res) => {
    try {
        const { id } = req.params;
        // نتأكد أن هذه الحصة هي المفعلة حالياً
        const result = await db.query(
            "SELECT id, name, qr_enabled FROM sessions WHERE id = $1 AND qr_enabled = true", 
            [id]
        );

        if (result.rows.length === 0) {
            // إذا لم تكن الحصة مفعلة، نعيد المستخدم لصفحة الإدارة مع رسالة خطأ
            // يمكنك تخصيص صفحة خطأ أفضل لهذا
            return res.status(403).send('<h1>لا يمكن بدء المسح. يرجى تفعيل الحضور لهذه الحصة أولاً من لوحة التحكم.</h1><a href="/manage">العودة للوحة التحكم</a>');
        }
        
        const session = result.rows[0];
        res.render('scanner', { session }); // سنقوم بإنشاء ملف scanner.ejs

    } catch (error) {
        console.error("Error loading scanner page:", error);
        res.status(500).render('error', { message: 'خطأ في تحميل صفحة الماسح الضوئي.' });
    }
});

// 2. معالجة الباركود المسجل وتحديث الحضور
app.post('/scan/mark-attendance', async (req, res) => {
    const { unique_code } = req.body;
    
    if (!unique_code) {
        return res.status(400).json({ success: false, message: 'كود الطالب مطلوب.' });
    }

    const client = await db.connect();
    try {
        // أولاً، نجد الحصة المفعلة حالياً لتسجيل الحضور
        const activeSessionResult = await client.query("SELECT session_uuid FROM sessions WHERE qr_enabled = true LIMIT 1");
        
        if (activeSessionResult.rows.length === 0) {
            return res.status(400).json({ success: false, message: 'لا توجد حصة مفعلة لتسجيل الحضور.' });
        }
        
        const activeSessionUUID = activeSessionResult.rows[0].session_uuid;

        // ثانياً، نجد الطالب ونحدث بياناته
        await client.query('BEGIN');

        const studentResult = await client.query("SELECT student_name, data FROM students WHERE unique_code = $1", [unique_code]);
        if (studentResult.rows.length === 0) {
            // لا نستخدم throw new Error هنا لنتمكن من إرسال رسالة مخصصة
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
        
        // التحقق مما إذا كان الطالب قد سجل حضوره بالفعل
        if (studentData.sessions[sessionIndex].attendance === "حاضر") {
             await client.query('ROLLBACK'); // لا داعي للتحديث
             return res.json({ success: true, studentName: studentName, message: 'مسجل بالفعل' });
        }

        // تحديث الحضور
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


// 5. تشغيل الخادم
app.listen(port, () => {
    console.log(`Server is running at http://localhost:${port}`);
});