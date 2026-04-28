'use strict';
/** Adapter zod → express middleware. */
function validate(schema, where = 'body') {
  return (req, _res, next) => {
    const data = req[where];
    const parsed = schema.safeParse(data);
    if (!parsed.success) return next(parsed.error);
    req[where] = parsed.data;
    next();
  };
}
module.exports = { validate };
