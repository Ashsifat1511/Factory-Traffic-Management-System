import type { ControllerGateway, WireCommand } from '../../application/runtime.js';

/** Sends commands to the controller simulator over REST (plan §8.5). Fire-and-forget: a lost command is a missing ACK. */
export class RestControllerGateway implements ControllerGateway {
  constructor(private readonly url: string, private readonly token: string, private readonly log: (m: string) => void = () => undefined) {}

  send(_junctionId: string, command: WireCommand): void {
    fetch(`${this.url}/commands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-backend-token': this.token },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(1000),
    }).catch((e) => this.log(`command ${command.command_id} not delivered: ${(e as Error).message}`));
  }
}
