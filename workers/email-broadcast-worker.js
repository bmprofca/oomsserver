/**
 * Email Broadcast Background Worker
 * Standalone worker process for processing email broadcasts
 * Can be run separately or integrated with main server
 * 
 * Usage:
 * - node workers/email-broadcast-worker.js
 * - Or import and call startWorker() from server.js
 */

import "../utils/timezone.js";
import EmailBroadcastQueue from '../helpers/EmailBroadcastQueue.js';
import pool from '../db.js';

let isRunning = false;
let checkInterval = null;

/**
 * Start the worker
 */
async function startWorker() {
  if (isRunning) {
    console.log('⚠️  Worker already running');
    return;
  }

  isRunning = true;
  console.log('\n' + '='.repeat(60));
  console.log('📧 Email Broadcast Worker Started');
  console.log('='.repeat(60) + '\n');

  // Check for queued broadcasts every 10 seconds
  checkInterval = setInterval(async () => {
    await checkForQueuedBroadcasts();
  }, 10000);

  // Initial check
  await checkForQueuedBroadcasts();

  // Listen to queue events
  EmailBroadcastQueue.on('broadcast_completed', (data) => {
    console.log(`\n✅ Broadcast ${data.broadcastId} completed:`);
    console.log(`   Sent: ${data.totalSent}, Failed: ${data.totalFailed}, Duration: ${data.duration}s\n`);
  });

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n\n🛑 Received SIGINT. Gracefully shutting down worker...');
    stopWorker();
  });

  process.on('SIGTERM', () => {
    console.log('\n\n🛑 Received SIGTERM. Gracefully shutting down worker...');
    stopWorker();
  });
}

/**
 * Stop the worker
 */
function stopWorker() {
  if (!isRunning) {
    return;
  }

  console.log('\n' + '='.repeat(60));
  console.log('🛑 Stopping Email Broadcast Worker...');
  console.log('='.repeat(60));

  if (checkInterval) {
    clearInterval(checkInterval);
    checkInterval = null;
  }

  const queueStatus = EmailBroadcastQueue.getStatus();
  
  if (queueStatus.processing) {
    console.log(`\n⏳ Waiting for current job to complete: ${queueStatus.currentJob}`);
    console.log('   Please wait or force quit with Ctrl+C again\n');
    
    // Wait for current job to finish
    const waitForCompletion = setInterval(() => {
      const status = EmailBroadcastQueue.getStatus();
      if (!status.processing) {
        clearInterval(waitForCompletion);
        finalizeShutdown();
      }
    }, 1000);

    // Force shutdown after 30 seconds
    setTimeout(() => {
      clearInterval(waitForCompletion);
      console.log('\n⚠️  Force shutdown after 30 seconds');
      finalizeShutdown();
    }, 30000);
  } else {
    finalizeShutdown();
  }
}

/**
 * Finalize shutdown
 */
async function finalizeShutdown() {
  isRunning = false;
  
  console.log('\n✅ Worker stopped successfully');
  console.log('   Remaining in queue:', EmailBroadcastQueue.getStatus().queueLength);
  console.log('');

  // Close database connection
  try {
    await pool.end();
    console.log('📊 Database connection closed\n');
  } catch (error) {
    console.error('Error closing database connection:', error);
  }

  process.exit(0);
}

/**
 * Check for queued broadcasts in database
 */
async function checkForQueuedBroadcasts() {
  try {
    const [broadcasts] = await pool.query(
      'SELECT broadcast_id FROM email_broadcasts WHERE status = ? ORDER BY created_at ASC',
      ['queued']
    );

    if (broadcasts.length > 0) {
      console.log(`\n📬 Found ${broadcasts.length} queued broadcast(s)`);
      
      for (const broadcast of broadcasts) {
        try {
          await EmailBroadcastQueue.enqueue(broadcast.broadcast_id);
        } catch (error) {
          console.error(`Error enqueueing broadcast ${broadcast.broadcast_id}:`, error.message);
        }
      }
    }
  } catch (error) {
    console.error('Error checking for queued broadcasts:', error);
  }
}

/**
 * Get worker status
 */
function getWorkerStatus() {
  return {
    running: isRunning,
    queue: EmailBroadcastQueue.getStatus()
  };
}

// If running directly (not imported)
if (import.meta.url === `file://${process.argv[1]}`) {
  startWorker().catch(error => {
    console.error('Fatal error starting worker:', error);
    process.exit(1);
  });
}

export { startWorker, stopWorker, getWorkerStatus };

