export interface Gateway {
  // The real, sole identifier once this entry has been recorded at least
  // once (see lib/gateway-registry.js) -- optional only because a
  // not-yet-provisioned "This machine" placeholder (see main.js's
  // listGatewaysWithActiveFlag) has no on-disk record yet to carry one.
  id?: string;
  retired?: boolean;
  retiredAt?: string | null;
  host: string;
  port: number | null;
  label?: string;
  active?: boolean;
  mode?: string;
  sshTarget?: string;
  sshPort?: number;
  sshKey?: string;
}
