import { logger } from "../logger";
import { CacheService } from "./cacheService";
import { FeedService } from "./feedService";

export class PrefetchService {
  constructor(private readonly feedService: FeedService, private readonly cacheService: CacheService) {}

  async prefetchVideoIds(videoIds: string[]): Promise<{ queued: string[]; skipped: string[] }> {
    const queued: string[] = [];
    const skipped: string[] = [];

    for (const videoId of videoIds) {
      const video = this.feedService.getVideo(videoId);
      if (!video) {
        skipped.push(videoId);
        continue;
      }

      queued.push(videoId);
      await this.cacheService.enqueuePrefetch(video);
    }

    logger.info("prefetch.enqueued", {
      queued: queued.length,
      skipped: skipped.length
    });

    return { queued, skipped };
  }
}
