export interface Gateway {
  host: string;
  port: number | null;
  label?: string;
  active?: boolean;
  mode?: string;
  sshTarget?: string;
  sshPort?: number;
  sshKey?: string;
}
