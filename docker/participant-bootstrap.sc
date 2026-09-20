import com.digitalasset.canton.config.NonNegativeDuration
import com.digitalasset.canton.config.RequireTypes.{NonNegativeLong, PositiveInt}

def main(): Unit = {
  application.health.wait_for_initialized()
  application.synchronizers.connect("global", "http://canton:5008")
  utils.retry_until_true { application.synchronizers.active("global") }

  // LocalNet owns this sequencer. This grants test traffic without a token purchase.
  val member = application.id
  val allowance = NonNegativeLong.tryCreate(1024L * 1024L * 1024L)
  val timeout = NonNegativeDuration.ofSeconds(30)
  def trafficState() =
    dexSequencer.traffic_control.traffic_state_of_members(Seq(member)).trafficStates.get(member)

  utils.retry_until_true(timeout) { trafficState().isDefined }
  val current = trafficState().get
  if (current.extraTrafficPurchased.value < allowance.value) {
    val serial = current.serial.fold(PositiveInt.one)(_.increment)
    dexSequencer.traffic_control.set_traffic_balance(member, serial, allowance)
  }
  // The cumulative grant survives restarts; consumed traffic is never reset.
  utils.retry_until_true(timeout) {
    trafficState().exists(_.extraTrafficPurchased.value >= allowance.value)
  }
  java.nio.file.Files.writeString(java.nio.file.Path.of("/tmp/participant-ready"), "ready")
}
