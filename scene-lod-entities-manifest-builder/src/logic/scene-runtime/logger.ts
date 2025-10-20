import { engine, CrdtMessage, CrdtMessageType } from '@dcl/ecs/dist-cjs'
import * as components from '@dcl/ecs/dist-cjs/components'
import { ReadWriteByteBuffer } from '@dcl/ecs/dist-cjs/serialization/ByteBuffer'
import { readMessage } from '@dcl/ecs/dist-cjs/serialization/crdt/message'

const Transform = components.Transform(engine)
const MeshRenderer = components.MeshRenderer(engine)
const GltfContainer = components.GltfContainer(engine)
const Material = components.Material(engine)
const VisibilityComponent = components.VisibilityComponent(engine)


export function* serializeCrdtMessages(prefix: string, data: Uint8Array) {
  const buffer = new ReadWriteByteBuffer(data)
  let message: CrdtMessage | null

  while ((message = readMessage(buffer))) {
    if (message.type === CrdtMessageType.PUT_COMPONENT) {
      const { componentId } = message
      const data = 'data' in message ? message.data : undefined
      if (![Transform.componentId, MeshRenderer.componentId, GltfContainer.componentId, Material.componentId, VisibilityComponent.componentId].includes(componentId)) {
        continue
      }
      try {
        const c = engine.getComponentOrNull(componentId)
        yield {
          entityId: message.entityId,
          componentId: c?.componentId,
          componentName: c?.componentName,
          data: data && c ? c.schema.deserialize(new ReadWriteByteBuffer(data)) : null
        }
      } catch (_) {}
    }
  }
}
