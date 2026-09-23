// 数据模型定义
import { hasHypertension as hasHBPKeyword, hasDiabetes as hasDMKeyword } from '../utils/disease'

export const UserModel = {
  // 用户基本信息
  user_id: '',
  username: '',
  name: '',
  age: 0,
  gender: '', // '男' | '女'
  height: 0,
  weight: 0,
  bmi: 0,
  disease_types: [], // ['高血压', '糖尿病', '肥胖']
  phone: '',
  emergency_contact: '',
  elderly_mode: true,
  voice_enabled: true,
  created_at: '',
  is_active: true
};

export const HealthRecordModel = {
  record_id: '',
  user_id: '',
  record_date: '',
  steps: 0,
  systolic_pressure: null, // 收缩压
  diastolic_pressure: null, // 舒张压
  blood_sugar: null,
  weight: null,
  heart_rate: null,
  exercise_minutes: 0,
  sleep_hours: null,
  mood_score: null, // 1-5
  notes: '',
  created_at: ''
};

export const PrescriptionModel = {
  prescription_id: '',
  user_id: '',
  exercise_plan: {
    type: '', // 运动类型
    duration: 0, // 持续时间(分钟)
    frequency: '', // 频率
    intensity: '' // 强度
  },
  diet_plan: {
    restrictions: [], // 饮食限制
    recommendations: [] // 饮食建议
  },
  medication_reminders: [
    {
      name: '',
      time: '',
      dosage: '',
      frequency: ''
    }
  ],
  target_goals: {
    steps: 0,
    weight_loss: 0,
    bp_target: '',
    blood_sugar_target: ''
  },
  generated_date: '',
  is_active: true,
  doctor_modified: false
};

export const BadgeModel = {
  badge_id: '',
  user_id: '',
  badge_type: '', // '步数达标' | '连续记录' | '体重下降' | '血压稳定' | '血糖控制' | '运动坚持' | '社区贡献'
  badge_name: '',
  badge_description: '',
  badge_icon: '',
  earned_date: '',
  level: 1,
  points: 10
};

export const DoctorNoteModel = {
  note_id: '',
  doctor_id: '',
  user_id: '',
  content: '',
  note_type: '', // '建议' | '警告' | '表扬' | '处方调整'（该枚举取自 DB note_type CHECK 约束，属数据契约，非界面文案）
  priority: '', // '低' | '中' | '高' | '紧急'
  is_read: false,
  created_at: ''
};

export const UserLevelModel = {
  level_id: '',
  user_id: '',
  current_level: 1,
  total_points: 0,
  level_name: '',
  next_level_points: 0,
  updated_at: ''
};

// 健康建议规则引擎
export const PrescriptionRules = {
  // BMI分类
  getBMICategory: (bmi) => {
    if (bmi < 18.5) return '偏瘦';
    if (bmi < 24) return '正常';
    if (bmi < 28) return '超重';
    return '肥胖';
  },

  // 根据用户信息生成运动建议
  generateExercisePlan: (user) => {
    const { bmi, age, disease_types } = user;
    const hasHypertension = hasHBPKeyword(disease_types);
    const hasDiabetes = hasDMKeyword(disease_types);
    const isObese = bmi >= 28;

    let plan = {
      type: '快走',
      duration: 30,
      frequency: '每日',
      intensity: '低强度'
    };

    if (isObese && hasHypertension) {
      plan = {
        type: '低强度快走',
        duration: 150, // 每周总时长
        frequency: '每周5次，每次30分钟',
        intensity: '低强度',
        additional: '避免剧烈运动，注意心率监测'
      };
    } else if (isObese && hasDiabetes) {
      plan = {
        type: '有氧运动+抗阻训练',
        duration: 180, // 每周总时长
        frequency: '有氧运动每周5次，抗阻训练每周2次',
        intensity: '中低强度',
        additional: '运动前后监测血糖'
      };
    } else if (hasHypertension) {
      plan = {
        type: '快走或慢跑',
        duration: 150,
        frequency: '每周5次',
        intensity: '中等强度',
        additional: '避免憋气动作'
      };
    }

    return plan;
  },

  // 根据用户信息生成饮食方案
  generateDietPlan: (user) => {
    const { disease_types, bmi } = user;
    const hasHypertension = hasHBPKeyword(disease_types);
    const hasDiabetes = hasDMKeyword(disease_types);
    const isObese = bmi >= 28;

    let plan = {
      restrictions: [],
      recommendations: ['均衡饮食', '适量饮水']
    };

    if (hasHypertension) {
      plan.restrictions.push('限盐（每日<6g）', '限制高钠食物');
      plan.recommendations.push('多食用富含钾的食物', '增加蔬菜水果摄入');
    }

    if (hasDiabetes) {
      plan.restrictions.push('限制精制糖', '控制碳水化合物');
      plan.recommendations.push('选择低GI食物', '少食多餐', '增加膳食纤维');
    }

    if (isObese) {
      plan.restrictions.push('控制总热量', '减少油脂摄入');
      plan.recommendations.push('增加蛋白质比例', '多食用饱腹感强的食物');
    }

    return plan;
  },

  // 生成用药提醒
  generateMedicationReminders: (user) => {
    const { disease_types } = user;
    const reminders = [];

    if (hasHBPKeyword(disease_types)) {
      reminders.push({
        name: '降压药',
        time: '08:00',
        dosage: '按医嘱服用',
        frequency: '每日一次',
        notes: '餐前服用，注意监测血压'
      });
    }

    if (hasDMKeyword(disease_types)) {
      reminders.push({
        name: '降糖药',
        time: '07:30',
        dosage: '按医嘱服用',
        frequency: '每日一次',
        notes: '餐前30分钟服用'
      });
    }

    return reminders;
  }
};

// 勋章系统规则
export const BadgeRules = {
  // 检查是否获得新勋章
  checkNewBadges: (user, healthRecords, currentBadges) => {
    const newBadges = [];

    // 步数达标勋章
    const recentSteps = healthRecords.slice(-7).map(r => r.steps);
    const avgSteps = recentSteps.reduce((a, b) => a + b, 0) / recentSteps.length;
    if (avgSteps >= 8000 && !currentBadges.some(b => b.badge_type === '步数达标')) {
      newBadges.push({
        badge_type: '步数达标',
        badge_name: '健步如飞',
        badge_description: '连续7天平均步数超过8000步',
        points: 50
      });
    }

    // 连续记录勋章
    const consecutiveDays = getConsecutiveRecordDays(healthRecords);
    if (consecutiveDays >= 7 && !currentBadges.some(b => b.badge_type === '连续记录')) {
      newBadges.push({
        badge_type: '连续记录',
        badge_name: '坚持不懈',
        badge_description: '连续7天记录健康数据',
        points: 30
      });
    }

    return newBadges;
  }
};

// 辅助函数
function getConsecutiveRecordDays(records) {
  if (records.length === 0) return 0;

  const sortedRecords = records.sort((a, b) => new Date(b.record_date) - new Date(a.record_date));
  let consecutive = 1;

  for (let i = 1; i < sortedRecords.length; i++) {
    const currentDate = new Date(sortedRecords[i - 1].record_date);
    const prevDate = new Date(sortedRecords[i].record_date);
    const diffDays = (currentDate - prevDate) / (1000 * 60 * 60 * 24);

    if (diffDays === 1) {
      consecutive++;
    } else {
      break;
    }
  }

  return consecutive;
}