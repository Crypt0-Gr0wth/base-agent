import { Router, type IRouter, type Request, type Response } from "express";
import { Readable } from "stream";
import { z } from "zod/v4";
import { take } from "../lib/rate-limit";
import { getCurrentUserId } from "../lib/user";
import {
  ObjectStorageService,
  ObjectNotFoundError,
} from "../lib/objectStorage";

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

const RequestUploadUrlBody = z.object({
  name: z.string().min(1),
  size: z.number().int().positive().max(10 * 1024 * 1024),
  contentType: z.string().regex(/^image\/(png|jpe?g|webp|gif)$/),
});

// POST /storage/uploads/request-url — returns a presigned PUT URL plus the
// object path to persist. The client uploads the file bytes directly to GCS.
// Session-gated (all /api/* require a session); image-only, ≤10 MB.
router.post(
  "/storage/uploads/request-url",
  async (req: Request, res: Response): Promise<void> => {
    const rate = take(getCurrentUserId(), "security");
    if (!rate.allowed) {
      res.setHeader("Retry-After", String(rate.retryAfterSec));
      res.status(429).json({ error: "rate limited" });
      return;
    }
    const parsed = RequestUploadUrlBody.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "image only (png/jpg/webp/gif), max 10MB" });
      return;
    }
    try {
      const uploadURL = await objectStorageService.getObjectEntityUploadURL();
      const objectPath =
        objectStorageService.normalizeObjectEntityPath(uploadURL);
      res.json({ uploadURL, objectPath });
    } catch (error) {
      req.log.error({ err: error }, "Error generating upload URL");
      res.status(500).json({ error: "failed to generate upload URL" });
    }
  },
);

// GET /storage/objects/*path — serve an uploaded object. Avatars are marked
// public ACL on save (for cache headers); the route itself is still behind the
// app session middleware, which is fine because the whole app requires sign-in.
router.get(
  "/storage/objects/*path",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const raw = req.params["path"];
      const wildcardPath = Array.isArray(raw) ? raw.join("/") : raw;
      const objectPath = `/objects/${wildcardPath}`;
      const objectFile =
        await objectStorageService.getObjectEntityFile(objectPath);
      const canAccess = await objectStorageService.canAccessObjectEntity({
        userId: getCurrentUserId(),
        objectFile,
      });
      if (!canAccess) {
        res.status(403).json({ error: "forbidden" });
        return;
      }
      const response = await objectStorageService.downloadObject(objectFile);

      res.status(response.status);
      response.headers.forEach((value, key) => res.setHeader(key, value));

      if (response.body) {
        const nodeStream = Readable.fromWeb(
          response.body as ReadableStream<Uint8Array>,
        );
        nodeStream.pipe(res);
      } else {
        res.end();
      }
    } catch (error) {
      if (error instanceof ObjectNotFoundError) {
        res.status(404).json({ error: "object not found" });
        return;
      }
      req.log.error({ err: error }, "Error serving object");
      res.status(500).json({ error: "failed to serve object" });
    }
  },
);

export default router;
