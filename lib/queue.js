/**
 * Async Concurrency Queue
 * Prevents system starvation, DoS, and CPU freeze by bounding parallel
 * image generation processes to a safe concurrency limit.
 */

class AsyncQueue {
  constructor(concurrency = 1, maxQueueSize = 50) {
    this.concurrency = concurrency;
    this.maxQueueSize = maxQueueSize;
    this.running = 0;
    this.queue = [];
    this.totalProcessed = 0;
    this.totalErrors = 0;
  }

  /**
   * Enqueue a job
   * @param {Function} task - Async function to run
   * @returns {Promise<any>}
   */
  enqueue(task) {
    if (this.queue.length >= this.maxQueueSize) {
      const error = new Error('Server busy: generation queue is full. Please try again shortly.');
      error.statusCode = 503;
      return Promise.reject(error);
    }

    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject, enqueuedAt: Date.now() });
      this._drain();
    });
  }

  _drain() {
    if (this.running >= this.concurrency || this.queue.length === 0) {
      return;
    }

    const { task, resolve, reject } = this.queue.shift();
    this.running++;

    Promise.resolve()
      .then(task)
      .then((res) => {
        this.totalProcessed++;
        resolve(res);
      })
      .catch((err) => {
        this.totalErrors++;
        reject(err);
      })
      .finally(() => {
        this.running--;
        this._drain();
      });
  }

  getStats() {
    return {
      concurrency: this.concurrency,
      running: this.running,
      queued: this.queue.length,
      total_processed: this.totalProcessed,
      total_errors: this.totalErrors
    };
  }
}

module.exports = { AsyncQueue };
