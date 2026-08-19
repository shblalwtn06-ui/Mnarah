'use strict';

/**
 * middleware عام للتحقق من صحة المدخلات عبر Joi schema (بند 8 من المواصفات)
 * @param {import('joi').Schema} schema
 * @param {'body'|'query'|'params'} property
 */
function validate(schema, property = 'body') {
  return (req, res, next) => {
    const { error, value } = schema.validate(req[property], {
      abortEarly: false,
      stripUnknown: true
    });
    if (error) {
      return res.status(400).json({
        error: 'بيانات غير صالحة',
        details: error.details.map((d) => ({ field: d.path.join('.'), message: d.message }))
      });
    }
    req[property] = value;
    next();
  };
}

module.exports = validate;
