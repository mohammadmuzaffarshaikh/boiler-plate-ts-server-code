import { OAS3Definition } from "swagger-jsdoc";
import { FileStatus } from "@prisma/client";
import { folderPolicy, uploadFolders } from "../../config/constants";

/**
 * OpenAPI path definitions for `src/routes/file.routes.ts`.
 *
 * Plain objects rather than `@swagger` JSDoc comments, for the reason
 * spelled out at the top of `auth.docs.ts`: TypeScript strips standalone
 * comments, so a comment-based docs file compiles to an empty module and
 * production silently serves docs with no paths.
 */

type Paths = NonNullable<OAS3Definition["paths"]>;

const ref = (name: string) => ({ $ref: `#/components/responses/${name}` });

const fileResponse = (description: string) => ({
  description,
  content: {
    "application/json": {
      schema: {
        type: "object",
        properties: {
          status: { type: "string", example: "success" },
          message: { type: "string" },
          data: {
            type: "object",
            properties: { file: { $ref: "#/components/schemas/File" } },
          },
        },
      },
    },
  },
});

const fileIdParam = {
  name: "fileId",
  in: "path",
  required: true,
  schema: { type: "string", format: "uuid" },
  description: "File id (uuid).",
};

/**
 * Either scheme is accepted. Annotated rather than inferred: a bare array
 * literal of two differently-keyed objects infers each key as optionally
 * undefined, which does not satisfy OpenAPI's `SecurityRequirement` index
 * signature.
 */
const security: Record<string, string[]>[] = [
  { bearerAuth: [] },
  { cookieAuth: [] },
];

const filePaths: Paths = {
  "/app/files": {
    post: {
      summary: "Upload a file into one of the bucket folders",
      description:
        "Staff and admin only. Send the bytes in `file` and the " +
        "destination in `folder`.\n\n" +
        "`folder` decides two things: the key prefix in the bucket, and " +
        "which file types are accepted.\n\n" +
        "| folder | accepts |\n| --- | --- |\n" +
        "| `product_images` | JPEG, PNG, GIF, WebP, AVIF |\n" +
        "| `product_videos` | MP4, MOV, WebM |\n" +
        "| `documents` | PDF, DOCX, XLSX, PPTX, DOC, XLS, PPT |\n" +
        "| `profile_images` | JPEG, PNG, GIF, WebP, AVIF |\n\n" +
        "The type is decided by the file's magic bytes, never by its " +
        "filename or the declared Content-Type — both are " +
        "client-controlled and both are ignored. Office documents are " +
        "identified by opening the container, because every OOXML file is " +
        "a ZIP and every legacy one is an OLE compound file; a plain " +
        "archive and a macro-enabled document (.docm/.xlsm) are both " +
        "refused. SVG is rejected deliberately — it can carry script and " +
        "would be served from your own domain.\n\n" +
        "The object key is `<folder>/<slug>-<uuid>.<ext>`. The folder is " +
        "an allowlist lookup, never the raw string; the slug is the " +
        "filename reduced to lowercase ASCII letters, digits and hyphens " +
        "(empty if nothing survives); uniqueness comes from the uuid.\n\n" +
        "A new file starts as `UNUSED` and is deleted by the nightly sweep " +
        "if nothing marks it `IN_USE` within the grace period.",
      tags: ["Files"],
      security,
      requestBody: {
        required: true,
        content: {
          "multipart/form-data": {
            schema: {
              type: "object",
              required: ["file", "folder"],
              properties: {
                file: {
                  type: "string",
                  format: "binary",
                  description:
                    "Images up to UPLOAD_MAX_IMAGE_MB, videos up to " +
                    "UPLOAD_MAX_VIDEO_MB, documents up to " +
                    "UPLOAD_MAX_DOCUMENT_MB. The cap applied is the one " +
                    "for what the file really is, not what it claims to be.",
                },
                folder: {
                  type: "string",
                  enum: [...uploadFolders],
                  description: Object.entries(folderPolicy)
                    .map(([name, accepts]) => `${name}: ${accepts.join(", ")}`)
                    .join(" | "),
                },
              },
            },
          },
        },
      },
      responses: {
        "201": fileResponse("File uploaded"),
        "400": ref("BadRequest"),
        "401": ref("Unauthorized"),
        "403": ref("Forbidden"),
        "413": {
          description: "File exceeds the limit for its type",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Error" },
              example: { code: 413, message: "File is too large." },
            },
          },
        },
        "415": {
          description: "File type not recognised or not accepted here",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Error" },
              example: {
                code: 415,
                message:
                  'image/jpeg is not accepted in "product_videos". That ' +
                  "folder takes: video.",
              },
            },
          },
        },
        "429": ref("TooManyRequests"),
        "502": {
          description: "Storage provider rejected the upload",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Error" },
              example: {
                code: 502,
                message:
                  "Storage provider rejected the request. Please try again.",
              },
            },
          },
        },
        "503": {
          description: "File storage is not configured (R2_ENABLED=false)",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Error" },
              example: {
                code: 503,
                message: "File storage is not configured on this server.",
              },
            },
          },
        },
      },
    },
    get: {
      summary: "List files",
      tags: ["Files"],
      security,
      parameters: [
        {
          name: "status",
          in: "query",
          schema: { type: "string", enum: Object.values(FileStatus) },
          description: "Filter by lifecycle status.",
        },
        {
          name: "folder",
          in: "query",
          schema: { type: "string", enum: [...uploadFolders] },
          description: "Filter by the folder the file was uploaded into.",
        },
        {
          name: "page",
          in: "query",
          schema: { type: "integer", minimum: 1, default: 1 },
        },
        {
          name: "limit",
          in: "query",
          schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
        },
      ],
      responses: {
        "200": {
          description: "A page of files",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  status: { type: "string", example: "success" },
                  data: {
                    type: "object",
                    properties: {
                      files: {
                        type: "array",
                        items: { $ref: "#/components/schemas/File" },
                      },
                      page: { type: "integer" },
                      limit: { type: "integer" },
                      totalPages: { type: "integer" },
                      totalResults: { type: "integer" },
                    },
                  },
                },
              },
            },
          },
        },
        "400": ref("BadRequest"),
        "401": ref("Unauthorized"),
        "403": ref("Forbidden"),
      },
    },
  },

  "/app/files/{fileId}": {
    get: {
      summary: "Fetch one file's metadata",
      tags: ["Files"],
      security,
      parameters: [fileIdParam],
      responses: {
        "200": fileResponse("The file"),
        "401": ref("Unauthorized"),
        "403": ref("Forbidden"),
        "404": ref("NotFound"),
      },
    },
    delete: {
      summary: "Delete a file",
      description:
        "Removes the object from R2 and the row from the database. Any " +
        "staff or admin may delete any file, including one uploaded by " +
        "someone else — product media is shared catalogue content.\n\n" +
        "The row is marked `PENDING_DELETE` before the object is removed, " +
        "so a crash partway leaves work the nightly sweep finishes rather " +
        "than a row pointing at an object that no longer exists.",
      tags: ["Files"],
      security,
      responses: {
        "200": {
          description: "Deleted",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Error" },
              example: {
                status: "success",
                message: "File deleted successfully.",
              },
            },
          },
        },
        "401": ref("Unauthorized"),
        "403": ref("Forbidden"),
        "404": ref("NotFound"),
        "502": {
          description: "Storage provider rejected the delete",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Error" },
            },
          },
        },
      },
      parameters: [fileIdParam],
    },
  },

  "/app/files/{fileId}/status": {
    patch: {
      summary: "Attach or detach a file",
      description:
        "`IN_USE` protects a file from the nightly sweep; `UNUSED` exposes " +
        "it to the sweep again after the grace period. `PENDING_DELETE` " +
        "cannot be set here — it is an internal step of the delete path, " +
        "and parking a row in it would have the sweep destroy the object " +
        "with no delete ever requested.",
      tags: ["Files"],
      security,
      parameters: [fileIdParam],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["status"],
              properties: {
                status: {
                  type: "string",
                  enum: [FileStatus.UNUSED, FileStatus.IN_USE],
                },
              },
              example: { status: FileStatus.IN_USE },
            },
          },
        },
      },
      responses: {
        "200": fileResponse("Status updated"),
        "400": ref("BadRequest"),
        "401": ref("Unauthorized"),
        "403": ref("Forbidden"),
        "404": ref("NotFound"),
      },
    },
  },
};

export default filePaths;
