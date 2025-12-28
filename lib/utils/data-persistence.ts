/**
 * Data Persistence & Recovery
 * 
 * Backup, export, and recovery mechanisms for IndexedDB data
 */

import { logger } from './logger';
import type { EncryptedEvent } from '@/types';

interface BackupData {
  version: number;
  timestamp: number;
  events: unknown[];
  devices: unknown[];
  streams: unknown[];
}

/**
 * Export all data from IndexedDB
 */
export async function exportData(): Promise<string> {
  try {
    const { getAllEvents, getDevices, getStreams } = await import('@/lib/sync/db');

    // Get all events
    const events = await getAllEvents();

    // Get all devices
    const devices = await getDevices();
    
    // Get all streams
    const streams = await getStreams();

    const backup: BackupData = {
      version: 1,
      timestamp: Date.now(),
      events,
      devices,
      streams,
    };

    const json = JSON.stringify(backup, null, 2);
    logger.info('Data exported', { eventCount: events.length, deviceCount: devices.length });
    return json;
  } catch (error) {
    logger.error('Failed to export data', error);
    throw error;
  }
}

/**
 * Download data as JSON file
 */
export async function downloadBackup(): Promise<void> {
  try {
    const data = await exportData();
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pocketbridge-backup-${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
    logger.info('Backup downloaded');
  } catch (error) {
    logger.error('Failed to download backup', error);
    throw error;
  }
}

/**
 * Import data from backup
 */
export async function importData(backupJson: string): Promise<void> {
  try {
    const backup: BackupData = JSON.parse(backupJson);

    if (!backup.version || !backup.timestamp) {
      throw new Error('Invalid backup format');
    }

    // Validate backup structure
    if (!Array.isArray(backup.events) || !Array.isArray(backup.devices)) {
      throw new Error('Invalid backup data structure');
    }

    // Import events
    const { storeEvent } = await import('@/lib/sync/db');
    for (const event of backup.events) {
      try {
        await storeEvent(event as EncryptedEvent);
      } catch (error) {
        logger.warn('Failed to import event', { error: error instanceof Error ? error.message : String(error) });
      }
    }
    
    // Import streams
    const { upsertStream } = await import('@/lib/sync/db');
    for (const stream of backup.streams) {
      try {
        await upsertStream(stream as any);
      } catch (error) {
        logger.warn('Failed to import stream', { error: error instanceof Error ? error.message : String(error) });
      }
    }

    // Import devices
    const { updateDeviceName } = await import('@/lib/utils/device');
    for (const device of backup.devices) {
      try {
        // TODO: Implement device import
        logger.debug('Device import', { device });
      } catch (error) {
        logger.warn('Failed to import device', { error: error instanceof Error ? error.message : String(error) });
      }
    }

    logger.info('Data imported', { 
      eventCount: backup.events.length, 
      deviceCount: backup.devices.length 
    });
  } catch (error) {
    logger.error('Failed to import data', error);
    throw error;
  }
}

/**
 * Check for data corruption
 */
export async function checkDataIntegrity(): Promise<{
  healthy: boolean;
  issues: string[];
}> {
  const issues: string[] = [];

  try {
    const { getAllEvents } = await import('@/lib/sync/db');

    // Check events
    try {
      const events = await getAllEvents();
      if (!Array.isArray(events)) {
        issues.push('Events data is not an array');
      }
    } catch (error) {
      issues.push(`Failed to read events: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Check devices
    try {
      const { getDevices } = await import('@/lib/sync/db');
      const devices = await getDevices();
      if (!Array.isArray(devices)) {
        issues.push('Devices data is not an array');
      }
    } catch (error) {
      issues.push(`Failed to read devices: ${error instanceof Error ? error.message : String(error)}`);
    }

    return {
      healthy: issues.length === 0,
      issues,
    };
  } catch (error) {
    logger.error('Data integrity check failed', error);
    return {
      healthy: false,
      issues: [`Integrity check failed: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
}

/**
 * Clear all data (use with caution)
 */
export async function clearAllData(): Promise<void> {
  try {
    if (typeof window === 'undefined') return;

    // Clear IndexedDB
    const dbName = 'PocketBridgeDB';
    const deleteReq = indexedDB.deleteDatabase(dbName);

    await new Promise<void>((resolve, reject) => {
      deleteReq.onsuccess = () => resolve();
      deleteReq.onerror = () => reject(deleteReq.error);
    });

    // Clear localStorage
    localStorage.clear();

    logger.info('All data cleared');
  } catch (error) {
    logger.error('Failed to clear data', error);
    throw error;
  }
}

