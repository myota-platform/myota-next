import {
  BaseRpcContext,
  Server,
  type CustomTransportStrategy,
  type ReadPacket,
} from '@nestjs/microservices';

/**
 * Runs messages received by a custom durable transport inside Nest's RPC
 * lifecycle so `@nestjs/observe` can create and finish one trace per message.
 * The owning worker remains responsible for broker delivery and acknowledgments.
 */
export class ObserveEventBridge
  extends Server
  implements CustomTransportStrategy
{
  readonly transportId = Symbol('myota-observed-event-bridge');
  private startListening!: () => void;
  private readonly listening = new Promise<void>((resolve) => {
    this.startListening = resolve;
  });

  listen(callback: (...optionalParams: unknown[]) => unknown): void {
    this.startListening();
    callback();
  }

  close(): void {}

  on<
    EventKey extends string = string,
    EventCallback extends Function = Function,
  >(_event: EventKey, _callback: EventCallback): void {}

  unwrap<T>(): T {
    return this as unknown as T;
  }

  async dispatch<TContext extends BaseRpcContext>(
    pattern: string,
    data: unknown,
    context: TContext,
  ): Promise<void> {
    await this.listening;
    const packet: ReadPacket = { pattern, data };
    await this.handleEvent(pattern, packet, context);
  }
}
