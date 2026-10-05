import type { BackupResultaat } from "../backup/maak.ts";

/** Achtergrondtaken die vanuit de webinterface kunnen worden gestart. */
export interface Diensten {
  backupNu(reden: string): Promise<BackupResultaat | undefined>;
  testHerstel(): Promise<string | undefined>;
  outlookOphalen(): Promise<string | undefined>;
  mollieSync(): Promise<string | undefined>;
  aiWachtrij(): void;
  herstart(): void;
}
