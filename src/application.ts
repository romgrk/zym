/*
 * Application lifecycle: owns the Adw.Application and the GLib main loop, and
 * builds the editor window when the application is activated.
 *
 * node-gtk integrates GLib's loop with Node's event loop automatically the first
 * time a main loop runs, so we just run an explicit GLib.MainLoop (and quit it
 * ourselves). Under the `gi:` ESM imports these `run()` calls return immediately
 * instead of blocking, so cleanup/quit happens from the window's handlers.
 *
 * The app is NON_UNIQUE: each launch runs its own process and window. Without
 * this, GApplication's default single-instance mode makes a second launch hand
 * off to the existing instance and exit silently — so the new process "starts
 * but no window appears". We don't (yet) implement window-raising or file
 * forwarding to a primary instance, so single-instance has no upside here.
 */
import GLib from 'gi:GLib-2.0';
import Gio from 'gi:Gio-2.0';
import Adw from 'gi:Adw-1';
import { AppWindow } from './ui/AppWindow.ts';
import { installStyles } from './styles.ts';
import { registerBundledFonts, fonts } from './fonts.ts';

const APP_ID = 'com.github.romgrk.zym';

export class Application {
  private readonly loop = GLib.MainLoop.new(null, false);
  private readonly app = new Adw.Application({
    applicationId: APP_ID,
    flags: Gio.ApplicationFlags.NON_UNIQUE,
  });
  private readonly initialFile?: string;

  constructor(initialFile: string | undefined) {
    this.initialFile = initialFile;
    this.app.on('activate', () => this.onActivate());
  }

  /** Run the application. Under the `gi:` ESM imports this returns immediately
   *  (the loop runs cooperatively with Node's); the process stays alive until
   *  `quit()` tears down the loop and the app. */
  run(): void {
    this.app.run([]);
  }

  private onActivate() {
    registerBundledFonts();
    installStyles();
    fonts.init(); // central font stylesheet + follow system font changes (after the display exists)
    new AppWindow(this.app, () => this.quit(), this.initialFile);
    this.loop.run();
  }

  private quit() {
    this.loop.quit();
    this.app.quit();
  }
}
