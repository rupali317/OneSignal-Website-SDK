import Path from '../models/Path';
import { contains } from '../utils';
import SdkEnvironment from './SdkEnvironment';
import Environment from '../Environment';
export enum ServiceWorkerActiveState {
  /**
   * OneSignalSDKWorker.js, or the equivalent custom file name, is active.
   */
  WorkerA = <any>'Worker A (Main)',
  /**
   * OneSignalSDKUpdaterWorker.js, or the equivalent custom file name, is
   * active.
   */
  WorkerB = <any>'Worker B (Updater)',
  /**
   * A service worker is active, but it is neither OneSignalSDKWorker.js nor
   * OneSignalSDKUpdaterWorker.js (or the equivalent custom file names as
   * provided by user config).
   */
  ThirdParty = <any>'3rd Party',
  /**
   * No service worker is installed.
   */
  None = <any>'None'
}

export interface ServiceWorkerManagerConfig {
  workerAPath: Path,
  workerBPath: Path,
  registrationScope: string
}

export class ServiceWorkerManager {

  static UPDATED_FLAG = 'onesignal-update-serviceworker-completed';

  constructor(private config: ServiceWorkerManagerConfig) {

  }

  async getActiveState(): Promise<ServiceWorkerActiveState> {
    /*
      Note: This method can only be called on a secure origin. On an insecure
      origin, it'll throw on getRegistration().
    */

    /*
      We want to find out if the *current* page is currently controlled by an
      active service worker.

      There are three ways (sort of) to do this:
        - getRegistration()
        - getRegistrations()
        - navigator.serviceWorker.ready

      We want to use getRegistration(), since it will not return a value if the
      page is not currently controlled by an active service worker.

      getRegistrations() returns all service worker registrations under the
      origin (i.e. registrations in nested folders).

      navigator.serviceWorker.ready will hang indefinitely and never resolve if
      no registration is active.
    */
    const workerRegistration = await navigator.serviceWorker.getRegistration();
    if (!workerRegistration) {
      /*
        A site may have a service worker nested at /folder1/folder2/folder3,
        while the user is currently on /folder1. The nested service worker does
        not control /folder1 though. Although the nested service worker can
        receive push notifications without issue, it cannot perform other SDK
        operations like checking whether existing tabs are optn eo the site on
        /folder1 (used to prevent opening unnecessary new tabs on notification
        click.)

        Because we rely on being able to communicate with the service worker for
        SDK operations, we only say we're active if the service worker directly
        controls this page.
       */
      return ServiceWorkerActiveState.None;
    } else if (!workerRegistration.active) {
      /*
        Workers that are installing or waiting won't be our service workers,
        since we use clients.claim() and skipWaiting() to bypass the install and
        waiting stages.
       */
      return ServiceWorkerActiveState.ThirdParty;
    }
    /*
        At this point, there is an active service worker registration
        controlling this page.

        Check the filename to see if it belongs to our A / B worker.
      */
    else if (contains(workerRegistration.active.scriptURL, this.config.workerAPath.getFileName())) {
      return ServiceWorkerActiveState.WorkerA;
    }
    else if (contains(workerRegistration.active.scriptURL, this.config.workerBPath.getFileName())) {
      return ServiceWorkerActiveState.WorkerB;
    }
    else {
      return ServiceWorkerActiveState.ThirdParty;
    }
  }

  private alreadyUpdatedWorkerThisSession(): boolean {
    const alreadyUpdatedThisSession = sessionStorage.getItem(ServiceWorkerManager.UPDATED_FLAG);
    return (alreadyUpdatedThisSession === "yes");
  }

  private markWorkerUpdated() {
    sessionStorage.setItem(ServiceWorkerManager.UPDATED_FLAG, "yes");
  }

  async getWorkerVersion() {
    const workerRegistration = await navigator.serviceWorker.getRegistration();
    return new Promise(resolve => {
      OneSignal._channel.on('serviceworker.version', (context, data) => {
        resolve(data);
      });
      OneSignal._channel.emit('data', 'serviceworker.version');
    });
  }

  /**
   * Performs a service worker update by swapping out the current service worker
   * with a content-identical but differently named alternate service worker
   * file.
   */
  async updateWorker() {
    const workerState = await this.getActiveState();
    const workerVersion = await this.getWorkerVersion();

    if (workerVersion !== Environment.version()) {
      let workerDirectory, workerFileName, fullWorkerPath;

      if (workerState === ServiceWorkerActiveState.WorkerA) {
        workerDirectory = this.config.workerAPath.getPathWithoutFileName();
        workerFileName = this.config.workerAPath.getFileName();
      } else if (workerState === ServiceWorkerActiveState.WorkerB) {
        workerDirectory = this.config.workerBPath.getPathWithoutFileName();
        workerFileName = this.config.workerBPath.getFileName();
      }

      fullWorkerPath = `${workerDirectory}/${SdkEnvironment.getBuildEnvPrefix()}${workerFileName}`;
      log.info(`[Service Worker Update] Updating service worker from v${workerVersion} --> v${Environment.version()}.`);
      log.debug(`[Service Worker Update] Registering new service worker`, fullWorkerPath);

      return await navigator.serviceWorker.register(fullWorkerPath, this.config.registrationScope);
      log.debug(`[Service Worker Update] Service worker registration complete.`);
    } else {
      log.info(`[Service Worker Update] Service worker version is current at v${workerVersion} (no update required).`);
    }
  }
}