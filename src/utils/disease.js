/**
 * 疾病谱识别工具
 *
 * 真实病历中的病名常带前缀或分级（「2型糖尿病」「原发性高血压」「高血压病3级」），
 * 因此一律使用「关键字包含匹配」，不能用全等比较，否则会漏判。
 */

export const DISEASE_KEYWORD = {
  hypertension: ['高血压'],
  diabetes: ['糖尿病'],
  dyslipidemia: ['高血脂', '血脂异常', '高脂血症'],
  obesity: ['肥胖'],
  chd: ['冠心病', '冠状动脉'],
  stroke: ['脑梗', '脑卒中', '中风'],
  ckd: ['肾病', '肾功能不全'],
}

/** 疾病谱中是否命中某类疾病（关键字包含匹配） */
export const hasDisease = (diseases = [], keywords = []) => {
  const list = Array.isArray(diseases) ? diseases : [diseases]
  const joined = list.filter(Boolean).join('|')
  return keywords.some((kw) => joined.includes(kw))
}

/** 便捷判定：高血压 */
export const hasHypertension = (diseases) => hasDisease(diseases, DISEASE_KEYWORD.hypertension)

/** 便捷判定：糖尿病 */
export const hasDiabetes = (diseases) => hasDisease(diseases, DISEASE_KEYWORD.diabetes)
