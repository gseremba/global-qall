Pod::Spec.new do |s|
  s.name             = 'GlobalQallVoip'
  s.version          = '10.0.0'
  s.summary          = 'Global Qall VoIP native module'
  s.description      = 'PushKit and CallKit support for Global Qall'
  s.license          = { :type => 'MIT' }
  s.author           = { 'Global Qall' => 'support@globalqall.com' }
  s.homepage         = 'https://globalqall.com'

  s.platform         = :ios, '15.1'
  s.swift_version    = '5.9'
  s.source           = { :git => '' }

  s.static_framework = true
  s.source_files     = '**/*.{h,m,mm,swift}'

  s.dependency 'ExpoModulesCore'
  s.dependency 'RNCallKeep'
  s.dependency 'RNVoipPushNotification'

  s.frameworks = 'PushKit', 'CallKit'
end
