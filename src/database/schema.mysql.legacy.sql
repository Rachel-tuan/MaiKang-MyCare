-- 迈康 MyCare 老年慢病多智能体协同健康管理平台 · 数据库结构
-- 创建时间: 2025

-- 用户表
CREATE TABLE users (
    user_id VARCHAR(36) PRIMARY KEY DEFAULT (UUID()),
    username VARCHAR(50) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    name VARCHAR(100) NOT NULL,
    age INT NOT NULL CHECK (age >= 0 AND age <= 150),
    gender ENUM('男', '女') NOT NULL,
    height DECIMAL(5,2) CHECK (height > 0),
    weight DECIMAL(5,2) CHECK (weight > 0),
    bmi DECIMAL(4,2) GENERATED ALWAYS AS (weight / ((height/100) * (height/100))) STORED,
    disease_types JSON, -- 存储疾病类型数组 ['高血压', '糖尿病', '肥胖']
    phone VARCHAR(20),
    emergency_contact VARCHAR(20),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    is_active BOOLEAN DEFAULT TRUE,
    elderly_mode BOOLEAN DEFAULT TRUE, -- 老年友好模式
    voice_enabled BOOLEAN DEFAULT TRUE -- 语音播报开关
);

-- 健康记录表
CREATE TABLE health_records (
    record_id VARCHAR(36) PRIMARY KEY DEFAULT (UUID()),
    user_id VARCHAR(36) NOT NULL,
    record_date DATE NOT NULL,
    steps INT DEFAULT 0,
    systolic_pressure INT, -- 收缩压
    diastolic_pressure INT, -- 舒张压
    blood_sugar DECIMAL(4,1), -- 血糖值
    weight DECIMAL(5,2),
    heart_rate INT,
    exercise_minutes INT DEFAULT 0, -- 运动时长(分钟)
    sleep_hours DECIMAL(3,1), -- 睡眠时长
    mood_score INT CHECK (mood_score >= 1 AND mood_score <= 5), -- 心情评分1-5
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
    UNIQUE KEY unique_user_date (user_id, record_date)
);

-- 健康处方表
CREATE TABLE prescriptions (
    prescription_id VARCHAR(36) PRIMARY KEY DEFAULT (UUID()),
    user_id VARCHAR(36) NOT NULL,
    exercise_plan JSON NOT NULL, -- 运动计划 {"type": "快走", "duration": 150, "frequency": "每周", "intensity": "低强度"}
    diet_plan JSON NOT NULL, -- 饮食方案 {"restrictions": ["减盐", "限糖"], "recommendations": ["多蔬菜", "适量蛋白质"]}
    medication_reminders JSON, -- 用药提醒 [{"name": "降压药", "time": "08:00", "dosage": "1片"}]
    target_goals JSON, -- 目标设定 {"steps": 8000, "weight_loss": 2, "bp_target": "140/90"}
    generated_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    is_active BOOLEAN DEFAULT TRUE,
    doctor_modified BOOLEAN DEFAULT FALSE,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

-- 勋章表
CREATE TABLE badges (
    badge_id VARCHAR(36) PRIMARY KEY DEFAULT (UUID()),
    user_id VARCHAR(36) NOT NULL,
    badge_type ENUM('步数达标', '连续记录', '体重下降', '血压稳定', '血糖控制', '运动坚持', '社区贡献') NOT NULL,
    badge_name VARCHAR(100) NOT NULL,
    badge_description TEXT,
    badge_icon VARCHAR(255), -- 勋章图标路径
    earned_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    level INT DEFAULT 1, -- 勋章等级
    points INT DEFAULT 10, -- 获得积分
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

-- 医生备注表
CREATE TABLE doctor_notes (
    note_id VARCHAR(36) PRIMARY KEY DEFAULT (UUID()),
    doctor_id VARCHAR(36) NOT NULL,
    user_id VARCHAR(36) NOT NULL,
    content TEXT NOT NULL,
    note_type ENUM('建议', '警告', '表扬', '处方调整') DEFAULT '建议',
    priority ENUM('低', '中', '高', '紧急') DEFAULT '中',
    is_read BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

-- 医生表
CREATE TABLE doctors (
    doctor_id VARCHAR(36) PRIMARY KEY DEFAULT (UUID()),
    username VARCHAR(50) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    name VARCHAR(100) NOT NULL,
    title VARCHAR(50), -- 职称
    department VARCHAR(100), -- 科室
    phone VARCHAR(20),
    email VARCHAR(100),
    license_number VARCHAR(50), -- 执业证号
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    is_active BOOLEAN DEFAULT TRUE
);

-- 医患关系表
CREATE TABLE doctor_patient_relations (
    relation_id VARCHAR(36) PRIMARY KEY DEFAULT (UUID()),
    doctor_id VARCHAR(36) NOT NULL,
    user_id VARCHAR(36) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    is_active BOOLEAN DEFAULT TRUE,
    FOREIGN KEY (doctor_id) REFERENCES doctors(doctor_id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
    UNIQUE KEY unique_doctor_patient (doctor_id, user_id)
);

-- 用户等级表
CREATE TABLE user_levels (
    level_id VARCHAR(36) PRIMARY KEY DEFAULT (UUID()),
    user_id VARCHAR(36) NOT NULL,
    current_level INT DEFAULT 1,
    total_points INT DEFAULT 0,
    level_name VARCHAR(50),
    next_level_points INT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
    UNIQUE KEY unique_user_level (user_id)
);

-- 社区活动表
CREATE TABLE community_activities (
    activity_id VARCHAR(36) PRIMARY KEY DEFAULT (UUID()),
    title VARCHAR(200) NOT NULL,
    description TEXT,
    activity_type ENUM('运动挑战', '健康讲座', '经验分享', '群体活动') NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    target_audience JSON, -- 目标人群 ["高血压", "糖尿病"]
    reward_points INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    is_active BOOLEAN DEFAULT TRUE
);

-- 用户活动参与表
CREATE TABLE user_activity_participations (
    participation_id VARCHAR(36) PRIMARY KEY DEFAULT (UUID()),
    user_id VARCHAR(36) NOT NULL,
    activity_id VARCHAR(36) NOT NULL,
    joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completion_status ENUM('未开始', '进行中', '已完成', '已放弃') DEFAULT '未开始',
    completion_date TIMESTAMP NULL,
    points_earned INT DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
    FOREIGN KEY (activity_id) REFERENCES community_activities(activity_id) ON DELETE CASCADE,
    UNIQUE KEY unique_user_activity (user_id, activity_id)
);

-- 创建索引以提高查询性能
CREATE INDEX idx_health_records_user_date ON health_records(user_id, record_date);
CREATE INDEX idx_prescriptions_user_active ON prescriptions(user_id, is_active);
CREATE INDEX idx_badges_user_date ON badges(user_id, earned_date);
CREATE INDEX idx_doctor_notes_user_read ON doctor_notes(user_id, is_read);
CREATE INDEX idx_user_levels_points ON user_levels(total_points);

-- 插入示例数据（与 src/data/demoPatients.js 的示范病例保持一致）
-- 示范病例：张建国（原发性高血压）/ 李秀英（2 型糖尿病）/ 王建军（肥胖症）
INSERT INTO users (username, password_hash, name, age, gender, height, weight, disease_types, phone) VALUES
('zhangjianguo', '$2b$10$example_hash', '张建国', 68, '男', 170.0, 75.0, '["原发性高血压", "超重", "中心性肥胖"]', '13800138001'),
('lixiuying', '$2b$10$example_hash', '李秀英', 65, '女', 158.0, 66.0, '["2型糖尿病", "超重", "血脂异常"]', '13800138011'),
('wangjianjun', '$2b$10$example_hash', '王建军', 62, '男', 172.0, 92.0, '["肥胖症", "代谢综合征", "空腹血糖受损"]', '13800138021');

-- 医生端固定身份：李医生｜主任医师·全科（与 src/pages/DoctorPage.jsx 的 DOCTOR 常量一致）
INSERT INTO doctors (username, password_hash, name, title, department, phone, email) VALUES
('doc001', '$2b$10$example_hash', '李医生', '主任医师', '全科', '13900139001', 'dr.li@hospital.com');