import {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { Readable } from "node:stream";
import type { Config } from "./config.js";
import { tenantCall } from "./provision.js";
export class Backups {
  s3: S3Client;
  constructor(readonly c: Config) {
    this.s3 = new S3Client({
      endpoint: c.BACKUP_S3_ENDPOINT || undefined,
      region: "fi-hel1",
      forcePathStyle: true,
      credentials: {
        accessKeyId: c.BACKUP_ACCESS_KEY,
        secretAccessKey: c.BACKUP_SECRET_KEY,
      },
    });
  }
  prefix(t: any) {
    return `${this.c.BILLING_MODE}/${t.id}/`;
  }
  async objects(t: any) {
    const all: any[] = [];
    let continuation: string | undefined;
    do {
      const r = await this.s3.send(
        new ListObjectsV2Command({
          Bucket: this.c.BACKUP_S3_BUCKET,
          Prefix: this.prefix(t),
          ContinuationToken: continuation,
        }),
      );
      all.push(...(r.Contents ?? []));
      continuation = r.NextContinuationToken;
    } while (continuation);
    return all.sort(
      (a, b) => b.LastModified.getTime() - a.LastModified.getTime(),
    );
  }
  async take(t: any) {
    if (!this.c.BACKUP_S3_BUCKET || !this.c.BACKUP_AGE_RECIPIENT)
      throw Error("BACKUP_NOT_CONFIGURED");
    const response = await tenantCall(this.c, t, "backup", {});
    if (!response.body) throw Error("BACKUP_EMPTY");
    const key =
      this.prefix(t) + new Date().toISOString().slice(0, 10) + ".tar.age";
    await new Upload({
      client: this.s3,
      params: {
        Bucket: this.c.BACKUP_S3_BUCKET,
        Key: key,
        Body: Readable.fromWeb(response.body as any),
        ContentType: "application/octet-stream",
      },
      leavePartsOnError: false,
    }).done();
    const old = (await this.objects(t)).slice(7);
    if (old.length)
      await this.s3.send(
        new DeleteObjectsCommand({
          Bucket: this.c.BACKUP_S3_BUCKET,
          Delete: { Objects: old.map((x) => ({ Key: x.Key })) },
        }),
      );
  }
  async remove(t: any) {
    if (!this.c.BACKUP_S3_BUCKET) throw Error("BACKUP_NOT_CONFIGURED");
    const objects = await this.objects(t);
    for (let i = 0; i < objects.length; i += 1000) {
      const r = await this.s3.send(
        new DeleteObjectsCommand({
          Bucket: this.c.BACKUP_S3_BUCKET,
          Delete: {
            Objects: objects.slice(i, i + 1000).map((x) => ({ Key: x.Key })),
          },
        }),
      );
      if (r.Errors?.length) throw Error("BACKUP_DELETE_FAILED");
    }
  }
}
