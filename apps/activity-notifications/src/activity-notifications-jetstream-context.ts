import { BaseRpcContext } from '@nestjs/microservices';
import type { JsMsg } from '@nats-io/jetstream';
import { REQUEST_ID_HEADER, safeRequestId } from '@app/platform';

export class ActivityNotificationJetStreamContext extends BaseRpcContext<
  [JsMsg]
> {
  readonly headers: Record<string, string>;

  constructor(message: JsMsg) {
    super([message]);
    const requestId = safeRequestId(message.headers?.get(REQUEST_ID_HEADER));
    this.headers = requestId ? { [REQUEST_ID_HEADER]: requestId } : {};
  }

  getPattern(): string {
    return this.getArgByIndex(0).subject;
  }

  getMessage(): JsMsg {
    return this.getArgByIndex(0);
  }
}
