import Joi, { ObjectSchema } from "joi";
import { FileStatus } from "@prisma/client";
import { uploadFolders } from "../config/constants";

interface ValidationSchema {
  params?: ObjectSchema;
  query?: ObjectSchema;
  body?: ObjectSchema;
}

const fileId = Joi.string().uuid().required();

const folder = Joi.string()
  .valid(...uploadFolders)
  .required();

/**
 * The file itself is not described here. `validate` only ever inspects
 * `req.body`, `req.params` and `req.query`; the upload lives on `req.file`,
 * put there by multer, and is validated by its own type sniff in the
 * service. This schema pins down the multipart *text* fields and refuses
 * anything unexpected alongside them.
 *
 * `folder` is required rather than defaulted, and that is not a style
 * choice: `validate` throws away Joi's coerced value, so a `.default()`
 * here would validate successfully and then never reach `req.body`. The
 * handler would read `undefined` from a field the schema claims always has
 * a value — silent, and exactly the kind of bug this comment exists to
 * prevent. If a default is ever wanted, it belongs in the controller.
 */
const uploadFile: ValidationSchema = {
  body: Joi.object().keys({ folder }),
};

const listFiles: ValidationSchema = {
  query: Joi.object().keys({
    status: Joi.string().valid(...Object.values(FileStatus)),
    folder: Joi.string().valid(...uploadFolders),
    page: Joi.number().integer().min(1),
    limit: Joi.number().integer().min(1).max(100),
  }),
};

const getFile: ValidationSchema = {
  params: Joi.object().keys({ fileId }),
};

const updateStatus: ValidationSchema = {
  params: Joi.object().keys({ fileId }),
  body: Joi.object().keys({
    // PENDING_DELETE is deliberately not settable over the API. It is an
    // internal step of the delete path, and letting a caller park a row in
    // it would have the cron delete the object with no delete ever requested.
    status: Joi.string().valid(FileStatus.UNUSED, FileStatus.IN_USE).required(),
  }),
};

const deleteFile: ValidationSchema = {
  params: Joi.object().keys({ fileId }),
};

export { uploadFile, listFiles, getFile, updateStatus, deleteFile };
